/**
 * Ed25519 device signing keys.
 *
 * A device key is the root of authorship in Synk: an envelope's signature is the
 * only thing that binds a specific device to an update, because every member of
 * a notebook holds the same content key and so the AEAD proves nothing about
 * who wrote what. Attribution, capability chains and `did:key` principals all
 * hang off this pair.
 *
 * `generateSigningKey()` defaults to non-extractable. That is the point of
 * preferring WebCrypto: hostile code delivered in a compromised bundle can ask
 * the key to sign, but cannot read it and mail it somewhere. Under the `@noble`
 * fallback the scalar is ordinary heap bytes and the key reports
 * `extractable: true` - callers that care must check rather than assume.
 */

import { ed25519 } from "@noble/curves/ed25519.js"
import { curveSupport, type CurveBackendName } from "./backend"
import { asBufferSource, assertLength, fromBase64Url, type Bytes } from "./bytes"

export const ED25519_PUBLIC_KEY_BYTES = 32
export const ED25519_SECRET_KEY_BYTES = 32
export const ED25519_SIGNATURE_BYTES = 64

/**
 * DER header for a PKCS#8-wrapped Ed25519 seed. WebCrypto will not import a
 * bare 32-byte scalar, so a raw seed is wrapped in this fixed prefix; the
 * structure is constant for the algorithm, hence a literal rather than a DER
 * encoder.
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

export interface SigningKey {
  /** Raw 32-byte Ed25519 public key - the device's identity. */
  readonly publicKey: Bytes
  readonly backend: CurveBackendName
  /** False when the private scalar cannot leave the platform key store. */
  readonly extractable: boolean
  sign(message: Bytes): Promise<Bytes>
  /** The raw 32-byte seed, or null when the key is non-extractable. */
  exportSecretKey(): Promise<Bytes | null>
}

export interface GenerateSigningKeyOptions {
  /**
   * Allow the private key to be read back. Defaults to false. Only set this for
   * tests and for key material that is about to be deliberately serialised.
   */
  extractable?: boolean
}

function pkcs8(seed: Bytes): Bytes {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  out.set(ED25519_PKCS8_PREFIX, 0)
  out.set(seed, ED25519_PKCS8_PREFIX.length)
  return out
}

function nobleKey(seed: Bytes): SigningKey {
  const publicKey = ed25519.getPublicKey(seed)
  return {
    publicKey,
    backend: "noble",
    // The scalar is plain heap memory here whatever the caller asked for;
    // saying otherwise would be a lie the caller might rely on.
    extractable: true,
    // `@noble` is synchronous; wrapped to satisfy the async interface that the
    // WebCrypto backend genuinely needs.
    sign: (message) => Promise.resolve(ed25519.sign(message, seed)),
    exportSecretKey: () => Promise.resolve(seed.slice()),
  }
}

async function webcryptoKey(pair: CryptoKeyPair, extractable: boolean): Promise<SigningKey> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    publicKey,
    backend: "webcrypto",
    extractable,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, asBufferSource(message))),
    exportSecretKey: async () => {
      if (!extractable) return null
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
      if (!jwk.d) return null
      return fromBase64Url(jwk.d)
    },
  }
}

/** Fresh device signing key. Non-extractable unless asked otherwise. */
export async function generateSigningKey(
  options: GenerateSigningKeyOptions = {},
): Promise<SigningKey> {
  const extractable = options.extractable ?? false
  const support = await curveSupport()
  if (support.ed25519 === "noble") {
    return nobleKey(ed25519.utils.randomSecretKey())
  }
  const pair = await crypto.subtle.generateKey("Ed25519", extractable, ["sign", "verify"])
  return webcryptoKey(pair, extractable)
}

/**
 * Rebuild a signing key from its raw 32-byte seed. Used by the known-answer
 * tests and by any path that restores a previously exported key; a device key
 * created by `generateSigningKey` never travels this way.
 */
export async function importSigningKey(
  secretKey: Bytes,
  options: GenerateSigningKeyOptions = {},
): Promise<SigningKey> {
  assertLength(secretKey, ED25519_SECRET_KEY_BYTES, "Ed25519 secret key")
  const extractable = options.extractable ?? true
  const support = await curveSupport()
  if (support.ed25519 === "noble") return nobleKey(secretKey.slice())

  const wrapped = pkcs8(secretKey)
  // Imported extractable first only to read the matching public key out of the
  // JWK; the key actually retained is re-imported at the requested setting.
  const probe = await crypto.subtle.importKey("pkcs8", asBufferSource(wrapped), "Ed25519", true, [
    "sign",
  ])
  const jwk = await crypto.subtle.exportKey("jwk", probe)
  if (!jwk.x) throw new Error("WebCrypto did not expose the Ed25519 public key")
  const publicKeyBytes = fromBase64Url(jwk.x)

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asBufferSource(wrapped),
    "Ed25519",
    extractable,
    ["sign"],
  )
  const publicKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(publicKeyBytes),
    "Ed25519",
    true,
    ["verify"],
  )
  return webcryptoKey({ privateKey, publicKey }, extractable)
}

/**
 * Verify a detached signature against a raw public key.
 *
 * Returns false rather than throwing for every rejection - malformed key,
 * wrong-length signature, bad signature - because callers treat all of them
 * identically (drop the envelope) and a thrown error on attacker-controlled
 * input is just a second code path to get wrong.
 */
export async function verifySignature(
  publicKey: Bytes,
  message: Bytes,
  signature: Bytes,
): Promise<boolean> {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false
  if (signature.length !== ED25519_SIGNATURE_BYTES) return false
  const support = await curveSupport()
  if (support.ed25519 === "noble") {
    try {
      return ed25519.verify(signature, message, publicKey)
    } catch {
      return false
    }
  }
  try {
    const key = await crypto.subtle.importKey("raw", asBufferSource(publicKey), "Ed25519", true, [
      "verify",
    ])
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      asBufferSource(signature),
      asBufferSource(message),
    )
  } catch {
    return false
  }
}
