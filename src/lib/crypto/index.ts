/**
 * The narrow crypto interface (milestone M1). Four operations carry the whole
 * security model: sign/verify, seal/open, AEAD encrypt/decrypt, and HKDF.
 *
 * WebCrypto-first with a `@noble/curves` fallback for Ed25519 and X25519.
 * Nothing here knows about Yjs, notebooks, or the relay - keeping that true is
 * what lets the primitives be tested against published vectors.
 */

export type { Bytes } from "./bytes"
export {
  asBufferSource,
  concat,
  equalBytes,
  fromBase64Url,
  fromHex,
  randomBytes,
  toBase64Url,
  toHex,
  utf8,
  wipe,
} from "./bytes"

export type { CurveBackendName, CurveSupport } from "./backend"
export { curveSupport, resetCurveSupport, setCurveBackend } from "./backend"

export type { GenerateSigningKeyOptions, SigningKey, StorableSigningKey } from "./signing"
export {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SECRET_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  generateSigningKey,
  importSigningKey,
  restoreSigningKey,
  verifySignature,
} from "./signing"

export type { GenerateSealingKeyOptions, SealingKey, StorableSealingKey } from "./sealing"
export {
  generateSealingKey,
  importSealingKey,
  restoreSealingKey,
  seal,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
  x25519Agree,
  x25519PublicKey,
} from "./sealing"

export {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  generateAeadKey,
  randomNonce,
} from "./aead"

export { deriveKey, hkdf, HKDF_HASH } from "./kdf"
