/**
 * Its own signed record, not a mutation - capabilities are immutable tokens
 * held by whoever received them, so there is nothing to edit.
 *
 * Revocable by any issuer on the chain, or the owner. Eventually consistent:
 * there is a real window in which a peer has not seen it. DEK rotation is the
 * backstop for reads; for writes the window is accepted.
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
 * Entitlement is the part that matters: anyone can sign a revocation for any
 * cid, so a signature alone would let a stranger withdraw someone else's grant.
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
