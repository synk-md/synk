/**
 * Separately signed, eventually consistent revocations.
 *
 * A revocation is its own record rather than a mutation of the capability it
 * withdraws - capabilities are immutable signed tokens held by whoever received
 * them, and there is nothing to edit.
 *
 * Who may revoke: any issuer on the chain the capability rests on, or the
 * resource owner. Someone who granted authority can take it back; someone who
 * never granted it cannot.
 *
 * "Eventually consistent" is the honest part. A revocation propagates like any
 * other record, so there is a window in which a peer has not seen it and still
 * accepts the capability. DEK rotation is the cryptographic backstop for reads
 * (M5); for writes the window is real and accepted.
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
import type { Capability } from "./capability"

export const REVOCATION_VERSION = 1

export interface RevocationBody {
  v: typeof REVOCATION_VERSION
  /** The cid of the capability being withdrawn. */
  cid: string
  /** `did:key` of the revoker. Must be an issuer on the chain, or the owner. */
  iss: string
  /** Free-text, for an operator reading an audit trail. */
  reason?: string
  revokedAt: number
}

export interface Revocation extends RevocationBody {
  sig: string
}

export function revocationBytes(body: RevocationBody): Bytes {
  return utf8(
    [
      "synk/revocation/v1",
      String(body.v),
      body.cid,
      body.iss,
      body.reason ?? "",
      String(body.revokedAt),
    ].join("\n"),
  )
}

export interface RevokeOptions {
  signingKey: SigningKey
  issuer: string
  capabilityCid: string
  reason?: string
  revokedAt?: number
}

export async function revokeCapability(options: RevokeOptions): Promise<Revocation> {
  const issuerKey = publicKeyFromDid(options.issuer, "ed25519")
  if (toBase64Url(issuerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("issuer does not match the supplied signing key")
  }
  const body: RevocationBody = {
    v: REVOCATION_VERSION,
    cid: options.capabilityCid,
    iss: options.issuer,
    revokedAt: options.revokedAt ?? Date.now(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(revocationBytes(body))) }
}

/**
 * Is this revocation both authentic and issued by someone entitled to make it?
 *
 * Entitlement is the part worth getting right: anyone can sign a revocation for
 * any cid, so a valid signature alone would let a stranger withdraw a grant
 * they had nothing to do with.
 */
export async function verifyRevocation(
  revocation: Revocation,
  capability: Capability,
  chainIssuers: readonly string[],
  owner: string,
): Promise<boolean> {
  try {
    if (revocation.v !== REVOCATION_VERSION) return false
    if (revocation.cid !== capability.cid) return false
    if (revocation.iss !== owner && !chainIssuers.includes(revocation.iss)) return false

    const { sig, ...body } = revocation
    return await verifySignature(
      publicKeyFromDid(revocation.iss, "ed25519"),
      revocationBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/** The issuers along a chain, for judging who may revoke its leaf. */
export function chainIssuers(chain: readonly Capability[]): string[] {
  return [...new Set(chain.map((capability) => capability.payload.iss))]
}
