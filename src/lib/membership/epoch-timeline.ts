/**
 * Signing the epoch timeline.
 *
 * M5 left the timeline unsigned: records claiming whether an epoch was a
 * KDF-chain step or a fresh rotation were plain data. A peer that lied made a
 * member fail to derive a key they could have had, or try to derive one they
 * could not - denial and confusion rather than disclosure, because the sealed
 * boxes are bound to domain and epoch independently. Bounded, but not a thing
 * to leave unauthenticated where the timeline is persisted and replicated.
 *
 * So each record is asserted by an owner or admin, and a member derives keys
 * against the asserted structure rather than whatever the relay handed over.
 * `verifyTimeline` is the only way to turn records into an `EpochTimeline`, so
 * an unverified one cannot reach the derivation path by accident.
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
import { timelineIsWellFormed, type EpochRecord, type EpochTimeline } from "@/lib/keys"
import { canAdminister, type AuthorizationContext } from "@/lib/authz"

export const SIGNED_EPOCH_VERSION = 1

export interface SignedEpochRecord {
  v: typeof SIGNED_EPOCH_VERSION
  record: EpochRecord
  /** `did:key` of the owner or admin asserting this cut. */
  asserter: string
  sig: string
}

/** Canonical bytes. Fixed order, explicit - see `device-record.ts`. */
export function epochRecordBytes(record: EpochRecord, asserter: string): Bytes {
  return utf8(
    [
      "synk/epoch-record/v1",
      String(SIGNED_EPOCH_VERSION),
      record.domain,
      String(record.epoch),
      record.kind,
      record.reason,
      String(record.createdAt),
      asserter,
      // Only when present, so a record from before commitments signs as it did.
      ...(record.commitment === undefined ? [] : [`commitment:${record.commitment}`]),
    ].join("\n"),
  )
}

export async function signEpochRecord(
  record: EpochRecord,
  signingKey: SigningKey,
  asserter: string,
): Promise<SignedEpochRecord> {
  const asserterKey = publicKeyFromDid(asserter, "ed25519")
  if (toBase64Url(asserterKey) !== toBase64Url(signingKey.publicKey)) {
    throw new Error("asserter does not match the supplied signing key")
  }
  return {
    v: SIGNED_EPOCH_VERSION,
    record,
    asserter,
    sig: toBase64Url(await signingKey.sign(epochRecordBytes(record, asserter))),
  }
}

/**
 * Signature check plus admin authority.
 *
 * Both are needed: a valid signature from someone who is not an admin asserts
 * nothing about the domain's structure.
 */
export async function verifySignedEpochRecord(
  signed: SignedEpochRecord,
  context: AuthorizationContext,
): Promise<boolean> {
  try {
    if (signed.v !== SIGNED_EPOCH_VERSION) return false
    const asserterKey = publicKeyFromDid(signed.asserter, "ed25519")
    const authentic = await verifySignature(
      asserterKey,
      epochRecordBytes(signed.record, signed.asserter),
      fromBase64Url(signed.sig),
    )
    if (!authentic) return false
    return await canAdminister(signed.asserter, signed.record.domain, context)
  } catch {
    return false
  }
}

export interface TimelineVerification {
  ok: boolean
  timeline?: EpochTimeline
  reason?: "malformed" | "unsigned-record" | "unauthorized-asserter" | "empty"
  /** Epoch number of the first record that failed, when one did. */
  failedAt?: number
}

/**
 * The only route from records to a usable `EpochTimeline`.
 *
 * Every record must verify, and the sequence must be well formed - contiguous
 * from a single genesis, one domain. A timeline with a hole is refused whole
 * rather than truncated: deriving against a partial structure is exactly the
 * confusion signing is meant to prevent.
 */
export async function verifyTimeline(
  records: readonly SignedEpochRecord[],
  context: AuthorizationContext,
): Promise<TimelineVerification> {
  if (records.length === 0) return { ok: false, reason: "empty" }

  const ordered = [...records].sort((a, b) => a.record.epoch - b.record.epoch)
  for (const signed of ordered) {
    const authentic = await verifySignedEpochRecord(signed, context)
    if (!authentic) {
      // Distinguish "not signed by that key" from "signed, but by a non-admin",
      // because they mean different things to whoever is debugging.
      const signatureOnly = await verifySignature(
        publicKeyFromDid(signed.asserter, "ed25519"),
        epochRecordBytes(signed.record, signed.asserter),
        fromBase64Url(signed.sig),
      ).catch(() => false)
      return {
        ok: false,
        reason: signatureOnly ? "unauthorized-asserter" : "unsigned-record",
        failedAt: signed.record.epoch,
      }
    }
  }

  const timeline = ordered.map((signed) => signed.record)
  if (!timelineIsWellFormed(timeline)) return { ok: false, reason: "malformed" }
  return { ok: true, timeline }
}
