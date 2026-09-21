/**
 * AES-256-GCM, the content cipher, used with a notebook's epoch DEK.
 *
 * Provides confidentiality and integrity, but says nothing about *which* member
 * produced a ciphertext - all members hold the same DEK - so envelopes are
 * signed as well.
 */

import { asBufferSource, assertLength, randomBytes, type Bytes } from "./bytes"

export const AEAD_KEY_BYTES = 32
export const AEAD_NONCE_BYTES = 12
export const AEAD_TAG_BYTES = 16

/** A fresh 256-bit content key (a notebook epoch DEK). */
export function generateAeadKey(): Bytes {
  return randomBytes(AEAD_KEY_BYTES)
}

export function randomNonce(): Bytes {
  return randomBytes(AEAD_NONCE_BYTES)
}

async function importAesKey(key: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  assertLength(key, AEAD_KEY_BYTES, "AES-256-GCM key")
  return crypto.subtle.importKey("raw", asBufferSource(key), "AES-GCM", false, [usage])
}

/**
 * Encrypt under `key`. The returned ciphertext carries the GCM tag appended,
 * which is how WebCrypto represents it and what the envelope stores.
 *
 * `aad` is authenticated but not encrypted: envelope headers (author, sequence,
 * resource) go here so a ciphertext cannot be lifted out of one envelope and
 * replayed inside another that claims a different author or resource.
 */
export async function aeadEncrypt(
  key: Bytes,
  nonce: Bytes,
  plaintext: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  assertLength(nonce, AEAD_NONCE_BYTES, "AES-GCM nonce")
  const aesKey = await importAesKey(key, "encrypt")
  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: asBufferSource(nonce),
    tagLength: AEAD_TAG_BYTES * 8,
  }
  if (aad) params.additionalData = asBufferSource(aad)
  return new Uint8Array(await crypto.subtle.encrypt(params, aesKey, asBufferSource(plaintext)))
}

/**
 * Decrypt, or throw. Unlike signature verification this one throws: a failed
 * AEAD open after a signature has already verified means the sender and
 * receiver disagree about the key or the framing, which is a bug in our own
 * protocol rather than an attacker-shaped event to be counted and dropped.
 */
export async function aeadDecrypt(
  key: Bytes,
  nonce: Bytes,
  ciphertext: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  assertLength(nonce, AEAD_NONCE_BYTES, "AES-GCM nonce")
  if (ciphertext.length < AEAD_TAG_BYTES) throw new Error("ciphertext shorter than GCM tag")
  const aesKey = await importAesKey(key, "decrypt")
  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: asBufferSource(nonce),
    tagLength: AEAD_TAG_BYTES * 8,
  }
  if (aad) params.additionalData = asBufferSource(aad)
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, aesKey, asBufferSource(ciphertext)))
  } catch {
    throw new Error("AEAD open failed: wrong key, nonce, aad, or corrupted ciphertext")
  }
}
