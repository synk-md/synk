/**
 * The narrow crypto interface (milestone M1).
 *
 * Everything above this line - envelopes, keyrings, capabilities, snapshots -
 * talks to the primitives only through here. Four operations carry the whole
 * security model:
 *
 *   sign / verifySignature   authorship and capability chains (Ed25519)
 *   seal / open              getting an epoch DEK to a member (X25519 sealed box)
 *   aeadEncrypt / aeadDecrypt  content confidentiality (AES-256-GCM)
 *   hkdf                     domain separation and epoch key derivation
 *
 * Implementations are WebCrypto-first with a `@noble/curves` fallback for
 * Ed25519 and X25519; see `backend.ts` for why, and for how to force one in
 * tests. Nothing here knows about Yjs, notebooks, or the relay - keeping that
 * true is what lets the primitives be tested against published vectors.
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

export type { GenerateSigningKeyOptions, SigningKey } from "./signing"
export {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SECRET_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  generateSigningKey,
  importSigningKey,
  verifySignature,
} from "./signing"

export type { GenerateSealingKeyOptions, SealingKey } from "./sealing"
export {
  generateSealingKey,
  importSealingKey,
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
