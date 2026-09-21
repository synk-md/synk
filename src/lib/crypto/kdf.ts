/**
 * HKDF-SHA256 (RFC 5869). Turns an X25519 shared secret into an AES key inside
 * the sealed box, and walks the epoch rotation seed forward.
 *
 * Every call site passes a distinct `info` label, so a key derived for one
 * context can never be mistaken for another's.
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
