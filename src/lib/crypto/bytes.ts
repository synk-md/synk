/**
 * Byte helpers shared by the crypto primitives.
 *
 * Everything here is deliberately dependency-free and allocation-obvious: these
 * functions sit underneath signature verification and AEAD framing, so their
 * behaviour on odd input (wrong length, odd-length hex, non-ASCII) has to be
 * boring and predictable rather than clever.
 */

export type Bytes = Uint8Array

const HEX = "0123456789abcdef"

/** Fixed-size random bytes from the platform CSPRNG. */
export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

export function toHex(bytes: Bytes): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f]
  }
  return out
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error("hex string must have even length")
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`)
    out[i] = byte
  }
  return out
}

/**
 * base64url without padding - the encoding capability tokens and `did:key`
 * identifiers use, so key material survives a JWT-compact round trip unchanged.
 */
export function toBase64Url(bytes: Bytes): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text)
}

export function concat(...parts: Bytes[]): Bytes {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Length-independent-branch equality. Every comparison of a tag, signature, or
 * derived key goes through this: a plain `===` loop leaks how many leading
 * bytes matched, which is enough to forge a tag one byte at a time.
 */
export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Overwrite key material in place once it is no longer needed. */
export function wipe(bytes: Bytes): void {
  bytes.fill(0)
}

/**
 * Hand a `Bytes` to WebCrypto.
 *
 * `Uint8Array` is generic over its backing buffer since TypeScript 5.7, and
 * `BufferSource` demands `ArrayBuffer` specifically, so a plain `Uint8Array`
 * (which could in principle be backed by a `SharedArrayBuffer`) is not
 * assignable. Ours never are. This is that assertion, written once with the
 * reason attached rather than sprinkled as bare casts at every call site -
 * and it keeps the module compiling under a `lib` without DOM, which is how
 * the spike harness consumes it.
 */
export function asBufferSource(bytes: Bytes): BufferSource {
  return bytes as BufferSource
}

export function assertLength(bytes: Bytes, expected: number, what: string): Bytes {
  if (bytes.length !== expected) {
    throw new Error(`${what} must be ${expected} bytes, got ${bytes.length}`)
  }
  return bytes
}
