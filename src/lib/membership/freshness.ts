/**
 * The revocation set and its signed monotonic freshness summary.
 *
 * A relay that never forwards a revocation leaves every peer accepting a
 * removed member's writes indefinitely, and nothing in the record would show
 * it. The summary makes that visible: signed so it cannot be forged, monotonic
 * so it cannot be rolled back.
 *
 * It detects rather than prevents. DEK rotation is the backstop that denies
 * reads regardless of what the relay does.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

export const FRESHNESS_VERSION = 1

/** How old a summary may be before it is treated as stale. */
export const DEFAULT_MAX_SUMMARY_AGE_MS = 60 * 60 * 1000

export interface FreshnessSummaryBody {
  v: typeof FRESHNESS_VERSION
  /** Scope - the workspace whose revocation set this summarises. */
  workspace: string
  /** Monotonic. Never decreases for a given workspace. */
  seq: number
  /** How many revocations the set contains. */
  count: number
  /** Over the sorted revoked ids, so contents compare cheaply. */
  digest: string
  /** `did:key` of the issuer - the relay, or an admin publishing offline. */
  iss: string
  issuedAt: number
}

export interface FreshnessSummary extends FreshnessSummaryBody {
  sig: string
}

export function summaryBytes(body: FreshnessSummaryBody): Bytes {
  return utf8(
    [
      "synk/revocation-summary/v1",
      String(body.v),
      body.workspace,
      String(body.seq),
      String(body.count),
      body.digest,
      body.iss,
      String(body.issuedAt),
    ].join("\n"),
  )
}

/** Order-independent digest of a revocation set. */
export async function revocationSetDigest(ids: readonly string[]): Promise<string> {
  const canonical = utf8([...ids].sort().join("\n"))
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", canonical as BufferSource)),
  )
}

export interface IssueSummaryOptions {
  signingKey: SigningKey
  issuer: string
  workspace: string
  seq: number
  revokedIds: readonly string[]
  issuedAt?: number
}

export async function issueFreshnessSummary(
  options: IssueSummaryOptions,
): Promise<FreshnessSummary> {
  const issuerKey = publicKeyFromDid(options.issuer, "ed25519")
  if (toBase64Url(issuerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("issuer does not match the supplied signing key")
  }
  if (!Number.isInteger(options.seq) || options.seq < 0) {
    throw new Error("freshness sequence must be a non-negative integer")
  }

  const body: FreshnessSummaryBody = {
    v: FRESHNESS_VERSION,
    workspace: options.workspace,
    seq: options.seq,
    count: options.revokedIds.length,
    digest: await revocationSetDigest(options.revokedIds),
    iss: options.issuer,
    issuedAt: options.issuedAt ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(summaryBytes(body))) }
}

export async function verifyFreshnessSummary(
  summary: FreshnessSummary,
  trustedIssuers: readonly string[],
): Promise<boolean> {
  try {
    if (summary.v !== FRESHNESS_VERSION) return false
    if (!trustedIssuers.includes(summary.iss)) return false
    const { sig, ...body } = summary
    return await verifySignature(
      publicKeyFromDid(summary.iss, "ed25519"),
      summaryBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

export type FreshnessState = "fresh" | "stale" | "regressed" | "unverified" | "missing"

export interface FreshnessAssessment {
  state: FreshnessState
  /** Age of the accepted summary in ms, when there is one. */
  ageMs?: number
  /** True when the local revocation set does not match the summary's digest. */
  setMismatch?: boolean
  detail?: string
}

/**
 * Monotonicity lives here rather than in the record: a single summary cannot
 * tell you it is old, only a sequence can.
 */
export class FreshnessTracker {
  readonly workspace: string
  private readonly trustedIssuers: readonly string[]
  private readonly maxAgeMs: number
  private accepted: FreshnessSummary | undefined
  /** Set when a summary was refused for going backwards. */
  private regressionSeen = false

  constructor(
    workspace: string,
    trustedIssuers: readonly string[],
    maxAgeMs: number = DEFAULT_MAX_SUMMARY_AGE_MS,
  ) {
    this.workspace = workspace
    this.trustedIssuers = trustedIssuers
    this.maxAgeMs = maxAgeMs
  }

  get current(): FreshnessSummary | undefined {
    return this.accepted
  }

  /**
   * False for a rollback, and remembered: the relay has demonstrably
   * misbehaved, and a later valid summary should not erase that.
   */
  async offer(summary: FreshnessSummary): Promise<boolean> {
    if (summary.workspace !== this.workspace) return false
    if (!(await verifyFreshnessSummary(summary, this.trustedIssuers))) return false

    if (this.accepted && summary.seq < this.accepted.seq) {
      this.regressionSeen = true
      return false
    }
    if (this.accepted && summary.seq === this.accepted.seq) return true

    this.accepted = summary
    return true
  }

  get sawRegression(): boolean {
    return this.regressionSeen
  }

  /** Compared against the digest, so right count with wrong contents is caught. */
  assess(now: number, localRevokedIds?: readonly string[]): Promise<FreshnessAssessment> {
    return this.assessInternal(now, localRevokedIds)
  }

  private async assessInternal(
    now: number,
    localRevokedIds?: readonly string[],
  ): Promise<FreshnessAssessment> {
    if (this.regressionSeen) {
      return { state: "regressed", detail: "a summary older than one already accepted was offered" }
    }
    if (!this.accepted) {
      return { state: "missing", detail: "no verified summary has been seen" }
    }

    const ageMs = now - this.accepted.issuedAt
    const assessment: FreshnessAssessment = {
      state: ageMs > this.maxAgeMs ? "stale" : "fresh",
      ageMs,
    }
    if (assessment.state === "stale") {
      assessment.detail = `summary is ${String(Math.round(ageMs / 1000))}s old`
    }

    if (localRevokedIds) {
      const digest = await revocationSetDigest(localRevokedIds)
      if (digest !== this.accepted.digest) {
        assessment.setMismatch = true
        if (assessment.state === "fresh") {
          assessment.state = "stale"
          assessment.detail = "local revocation set does not match the summary digest"
        }
      }
    }
    return assessment
  }
}
