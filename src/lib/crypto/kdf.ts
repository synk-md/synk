/**
 * HKDF-SHA256 (RFC 5869).
 *
 * Two jobs in this system: turning a raw X25519 shared secret into an AES key
 * inside the sealed box, and walking the epoch rotation seed forward so the
 * retained keyring stays near-constant in size instead of growing with the
 * epoch count.
 *
 * `info` is never optional in practice - every call site passes a distinct
 * domain-separation label, so a derived key from one context can never be
 * mistaken for a key from another.
 */

import { asBufferSource, utf8, type Bytes } from "./bytes"

export const HKDF_HASH = "SHA-256"

export async function hkdf(
  ikm: Bytes,
  salt: Bytes,
  info: Bytes,
  length: number,
): Promise<Bytes> {
  if (length <= 0 || length > 255 * 32) {
    throw new Error(`HKDF output length out of range: ${length}`)
  }
  const key = await crypto.subtle.importKey("raw", asBufferSource(ikm), "HKDF", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: HKDF_HASH, salt: asBufferSource(salt), info: asBufferSource(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** Convenience for the common shape: string label, no salt, 32-byte output. */
export async function deriveKey(ikm: Bytes, label: string, length = 32): Promise<Bytes> {
  return hkdf(ikm, new Uint8Array(0), utf8(label), length)
}
