/**
 * The signed erasure order.
 *
 * Destroying keys locally erases nothing for anyone else - the sealed copies
 * are still on the relay and every other member still holds theirs. So erasure
 * has to propagate, and it propagates as a signed record that each holder
 * honours by destroying its own copies.
 *
 * Which means the guarantee is conditional on compliance, and the record says
 * so by carrying who ordered it rather than pretending to be a mechanism. A
 * holder that ignores it keeps reading.
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

export const ERASURE_VERSION = 1

export type ErasureScopeKind =
  /** The whole key domain. A deleted notebook, or a deleted promoted note. */
  | "domain"
  /** Everything up to an epoch, keeping current content via a snapshot. */
  | "history"

export interface ErasureBody {
  v: typeof ERASURE_VERSION
  /** Key domain whose epochs are destroyed. */
  domain: string
  resourceId: string
  scope: ErasureScopeKind
  /** Highest epoch destroyed. For a domain erasure, the whole timeline. */
  throughEpoch: number
  /** `did:key` of the admin ordering it. */
  issuer: string
  /**
   * Snapshot under a surviving epoch that preserves the content. Null for a
   * domain erasure, where losing the content is the point.
   */
  preservedBy: string | null
  reason?: string
  issuedAt: number
}

export interface ErasureRecord extends ErasureBody {
  sig: string
}

export function erasureBytes(body: ErasureBody): Bytes {
  return utf8(
    [
      "synk/erasure/v1",
      String(body.v),
      body.domain,
      body.resourceId,
      body.scope,
      String(body.throughEpoch),
      body.issuer,
      body.preservedBy ?? "",
      body.reason ?? "",
      String(body.issuedAt),
    ].join("\n"),
  )
}

export interface OrderErasureOptions {
  signingKey: SigningKey
  issuer: string
  domain: string
  resourceId: string
  scope: ErasureScopeKind
  throughEpoch: number
  preservedBy?: string | null
  reason?: string
  issuedAt?: number
}

export async function orderErasure(options: OrderErasureOptions): Promise<ErasureRecord> {
  const issuerKey = publicKeyFromDid(options.issuer, "ed25519")
  if (toBase64Url(issuerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("issuer does not match the supplied signing key")
  }
  if (!Number.isInteger(options.throughEpoch) || options.throughEpoch < 1) {
    throw new Error("erasure must name an epoch")
  }

  const body: ErasureBody = {
    v: ERASURE_VERSION,
    domain: options.domain,
    resourceId: options.resourceId,
    scope: options.scope,
    throughEpoch: options.throughEpoch,
    issuer: options.issuer,
    preservedBy: options.preservedBy ?? null,
    issuedAt: options.issuedAt ?? Date.now(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(erasureBytes(body))) }
}

/**
 * Authentic, and from an admin of this workspace.
 *
 * Entitlement matters more here than almost anywhere else: an erasure order is
 * the one record that asks every holder to destroy something irreversibly, so a
 * stranger being able to issue one would be a denial-of-service that cannot be
 * walked back.
 */
export async function verifyErasure(
  record: ErasureRecord,
  trustedAdminDids: readonly string[],
): Promise<boolean> {
  try {
    if (record.v !== ERASURE_VERSION) return false
    if (!trustedAdminDids.includes(record.issuer)) return false
    if (!Number.isInteger(record.throughEpoch) || record.throughEpoch < 1) return false
    if (record.scope !== "domain" && record.scope !== "history") return false
    const { sig, ...body } = record
    return await verifySignature(
      publicKeyFromDid(record.issuer, "ed25519"),
      erasureBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/**
 * How far erasure has actually got.
 *
 * `local` is the only tier that is certain, and it is certain immediately. The
 * others are claims about other people's devices, so they are counted rather
 * than asserted.
 */
export type ErasureTier = "local" | "workspace" | "archive"

export interface ErasureProgress {
  tier: ErasureTier
  /** Holders known to have destroyed their copies. */
  confirmed: string[]
  /** Holders that held a key and have not confirmed. */
  outstanding: string[]
  /** True only when nothing is outstanding at this tier. */
  complete: boolean
}

export function erasureProgress(
  tier: ErasureTier,
  holders: readonly string[],
  confirmed: Iterable<string>,
): ErasureProgress {
  const done = new Set(confirmed)
  const outstanding = holders.filter((holder) => !done.has(holder))
  return {
    tier,
    confirmed: holders.filter((holder) => done.has(holder)),
    outstanding,
    complete: outstanding.length === 0,
  }
}
