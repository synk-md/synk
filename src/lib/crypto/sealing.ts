/**
 * X25519 key agreement and the sealed-box construction.
 *
 * A sealed box is how a notebook's epoch DEK reaches a member: the key is
 * sealed once per authorised member's X25519 public key, and the resulting
 * copies can sit in the open keyring on an untrusted relay because each one
 * opens only with its recipient's private key. Adding, removing and rekeying
 * members are all just decisions about which sealed copies exist.
 *
 * Construction: ephemeral X25519 -> HKDF-SHA256 -> AES-256-GCM.
 *
 *   epk, esk  <- fresh X25519 keypair, one per seal
 *   shared    <- X25519(esk, recipientPk)
 *   key‖nonce <- HKDF(ikm = shared, salt = "", info = LABEL‖epk‖recipientPk, 44)
 *   box       <- epk ‖ AES-256-GCM(key, nonce, plaintext, aad)
 *
 * Two details are load-bearing. Both public keys go into the HKDF `info`, so a
 * ciphertext is bound to the exact pair it was produced for and cannot be
 * re-addressed by an attacker who swaps the recipient. And the nonce is derived
 * rather than carried: the ephemeral key is fresh for every seal, so the
 * (key, nonce) pair is unique by construction and there is nothing to store or
 * to get wrong.
 *
 * This is not libsodium's `crypto_box_seal` - that one is XSalsa20-Poly1305
 * with a Blake2b-derived nonce. Same shape, different primitives, chosen to
 * stay inside WebCrypto. It has not been externally reviewed; see the open
 * items in the design document before making any strong claim about it.
 */

import { x25519 } from "@noble/curves/ed25519.js"
import { AEAD_NONCE_BYTES, aeadDecrypt, aeadEncrypt, AEAD_KEY_BYTES } from "./aead"
import { curveSupport, type CurveBackendName } from "./backend"
import { asBufferSource, assertLength, concat, fromBase64Url, utf8, type Bytes } from "./bytes"
import { hkdf } from "./kdf"

export const X25519_PUBLIC_KEY_BYTES = 32
export const X25519_SECRET_KEY_BYTES = 32

/** Domain separation. Bump the suffix if the construction ever changes. */
const SEALED_BOX_LABEL = utf8("synk/sealed-box/v1")

const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

export interface SealingKey {
  /** Raw 32-byte X25519 public key - what others seal to. */
  readonly publicKey: Bytes
  readonly backend: CurveBackendName
  readonly extractable: boolean
  /** Open a sealed box addressed to this key. Throws if it was not. */
  open(box: Bytes, aad?: Bytes): Promise<Bytes>
  exportSecretKey(): Promise<Bytes | null>
}

export interface GenerateSealingKeyOptions {
  extractable?: boolean
}

function pkcs8(seed: Bytes): Bytes {
  const out = new Uint8Array(X25519_PKCS8_PREFIX.length + seed.length)
  out.set(X25519_PKCS8_PREFIX, 0)
  out.set(seed, X25519_PKCS8_PREFIX.length)
  return out
}

/**
 * X25519 rejects low-order points by producing an all-zero shared secret;
 * WebCrypto and `@noble` both surface that as a throw. Normalised here so a
 * caller sees one error regardless of backend.
 */
function agreementFailed(): never {
  throw new Error("X25519 agreement failed: peer public key is invalid or low-order")
}

/** shared secret -> (AES key, nonce), bound to both ends of the exchange. */
async function sealedBoxKey(
  shared: Bytes,
  ephemeralPublicKey: Bytes,
  recipientPublicKey: Bytes,
): Promise<{ key: Bytes; nonce: Bytes }> {
  const info = concat(SEALED_BOX_LABEL, ephemeralPublicKey, recipientPublicKey)
  const out = await hkdf(shared, new Uint8Array(0), info, AEAD_KEY_BYTES + AEAD_NONCE_BYTES)
  return { key: out.subarray(0, AEAD_KEY_BYTES), nonce: out.subarray(AEAD_KEY_BYTES) }
}

async function agreeWebCrypto(privateKey: CryptoKey, peerPublicKey: Bytes): Promise<Bytes> {
  try {
    const peer = await crypto.subtle.importKey(
      "raw",
      asBufferSource(peerPublicKey),
      "X25519",
      false,
      [],
    )
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256),
    )
  } catch {
    agreementFailed()
  }
}

function agreeNoble(secretKey: Bytes, peerPublicKey: Bytes): Bytes {
  try {
    return x25519.getSharedSecret(secretKey, peerPublicKey)
  } catch {
    agreementFailed()
  }
}

function nobleSealingKey(secretKey: Bytes): SealingKey {
  const publicKey = x25519.getPublicKey(secretKey)
  return {
    publicKey,
    backend: "noble",
    extractable: true,
    open: (box, aad) =>
      openWith(box, publicKey, aad, (epk) => Promise.resolve(agreeNoble(secretKey, epk))),
    exportSecretKey: () => Promise.resolve(secretKey.slice()),
  }
}

async function webcryptoSealingKey(
  pair: CryptoKeyPair,
  extractable: boolean,
): Promise<SealingKey> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    publicKey,
    backend: "webcrypto",
    extractable,
    open: (box, aad) => openWith(box, publicKey, aad, (epk) => agreeWebCrypto(pair.privateKey, epk)),
    exportSecretKey: async () => {
      if (!extractable) return null
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
      if (!jwk.d) return null
      return fromBase64Url(jwk.d)
    },
  }
}

/** Shared open path: split the box, redo the agreement, derive, decrypt. */
async function openWith(
  box: Bytes,
  recipientPublicKey: Bytes,
  aad: Bytes | undefined,
  agree: (ephemeralPublicKey: Bytes) => Promise<Bytes>,
): Promise<Bytes> {
  if (box.length < X25519_PUBLIC_KEY_BYTES) throw new Error("sealed box is truncated")
  const ephemeralPublicKey = box.slice(0, X25519_PUBLIC_KEY_BYTES)
  const ciphertext = box.subarray(X25519_PUBLIC_KEY_BYTES)
  const shared = await agree(ephemeralPublicKey)
  const { key, nonce } = await sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey)
  return aeadDecrypt(key, nonce, ciphertext, aad)
}

/** Fresh key-agreement key. Non-extractable unless asked otherwise. */
export async function generateSealingKey(
  options: GenerateSealingKeyOptions = {},
): Promise<SealingKey> {
  const extractable = options.extractable ?? false
  const support = await curveSupport()
  if (support.x25519 === "noble") return nobleSealingKey(x25519.utils.randomSecretKey())
  const pair = (await crypto.subtle.generateKey("X25519", extractable, [
    "deriveBits",
  ])) as CryptoKeyPair
  return webcryptoSealingKey(pair, extractable)
}

export async function importSealingKey(
  secretKey: Bytes,
  options: GenerateSealingKeyOptions = {},
): Promise<SealingKey> {
  assertLength(secretKey, X25519_SECRET_KEY_BYTES, "X25519 secret key")
  const extractable = options.extractable ?? true
  const support = await curveSupport()
  if (support.x25519 === "noble") return nobleSealingKey(secretKey.slice())

  const wrapped = pkcs8(secretKey)
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asBufferSource(wrapped),
    "X25519",
    extractable,
    ["deriveBits"],
  )
  // WebCrypto will not derive a public key from a private one, and X25519 keys
  // have no JWK `x` guarantee across engines, so the public half is computed
  // directly. The scalar is already in the heap on this path anyway.
  const publicKeyBytes = x25519.getPublicKey(secretKey)
  const publicKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(publicKeyBytes),
    "X25519",
    true,
    [],
  )
  return webcryptoSealingKey({ privateKey, publicKey }, extractable)
}

/**
 * Seal `plaintext` to `recipientPublicKey`. Anyone may seal - no sender key is
 * involved and the box carries no sender identity, which is exactly what the
 * keyring wants: a sealed DEK copy proves nothing about who placed it there,
 * and the delegation that authorised it is signed separately.
 */
export async function seal(
  recipientPublicKey: Bytes,
  plaintext: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  assertLength(recipientPublicKey, X25519_PUBLIC_KEY_BYTES, "X25519 recipient public key")
  const support = await curveSupport()

  let ephemeralPublicKey: Bytes
  let shared: Bytes
  if (support.x25519 === "noble") {
    const esk = x25519.utils.randomSecretKey()
    ephemeralPublicKey = x25519.getPublicKey(esk)
    shared = agreeNoble(esk, recipientPublicKey)
  } else {
    const pair = (await crypto.subtle.generateKey("X25519", false, [
      "deriveBits",
    ])) as CryptoKeyPair
    ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
    shared = await agreeWebCrypto(pair.privateKey, recipientPublicKey)
  }

  const { key, nonce } = await sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey)
  const ciphertext = await aeadEncrypt(key, nonce, plaintext, aad)
  return concat(ephemeralPublicKey, ciphertext)
}

/**
 * Raw X25519 agreement, exposed for the known-answer tests against RFC 7748.
 * Production code should reach for `seal`/`open` instead: a bare shared secret
 * used directly as a key is the classic way to lose domain separation.
 */
export async function x25519Agree(secretKey: Bytes, peerPublicKey: Bytes): Promise<Bytes> {
  assertLength(secretKey, X25519_SECRET_KEY_BYTES, "X25519 secret key")
  assertLength(peerPublicKey, X25519_PUBLIC_KEY_BYTES, "X25519 public key")
  const support = await curveSupport()
  if (support.x25519 === "noble") return agreeNoble(secretKey, peerPublicKey)
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asBufferSource(pkcs8(secretKey)),
    "X25519",
    false,
    ["deriveBits"],
  )
  return agreeWebCrypto(privateKey, peerPublicKey)
}

/** Public key for a raw X25519 secret. */
export function x25519PublicKey(secretKey: Bytes): Bytes {
  assertLength(secretKey, X25519_SECRET_KEY_BYTES, "X25519 secret key")
  return x25519.getPublicKey(secretKey)
}
