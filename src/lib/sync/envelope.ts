/**
 * The envelope: one encrypted Yjs update plus the metadata needed to verify,
 * authorise and place it. The only thing peers and the relay ever see.
 *
 * Encrypt then sign, so a receiver verifies and authorises before spending any
 * work decrypting attacker-supplied bytes. The header is also the AEAD's
 * associated data, so a ciphertext cannot be lifted into an envelope claiming a
 * different author, sequence, resource or epoch.
 *
 * Fields are base64url strings rather than byte arrays so an envelope is plain
 * JSON: it has to survive a relay, IndexedDB and a Yjs map unchanged.
 */

import {
  aeadDecrypt,
  aeadEncrypt,
  fromBase64Url,
  randomNonce,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"

/**
 * 2 adds a signed `createdAt`, which history needs to say when something was
 * written. 1 is still read: its bytes are unchanged, so it still verifies.
 */
export const ENVELOPE_VERSION = 2

export type EnvelopeVersion = 1 | 2

const isVersion = (v: unknown): v is EnvelopeVersion => v === 1 || v === 2

/**
 * What the sealed payload is.
 *
 * Presence, if it is ever added, travels as its own signed and encrypted
 * envelope type rather than as provider awareness - awareness is plaintext
 * metadata on the wire and carries no author signature. The discriminator is in
 * the header, and therefore signed and aad-bound, so adding a kind later costs
 * no format break and a receiver can never be confused about which it holds.
 */
export type EnvelopeKind = "update" | "presence"

export interface EnvelopeHeader {
  v: EnvelopeVersion
  kind: EnvelopeKind
  /** `did:key` of the authoring device's signing key. */
  author: string
  /** Per-author monotonic sequence number, starting at 1. */
  seq: number
  resourceId: string
  /** Which epoch DEK encrypted the payload. */
  epoch: number
  /** base64url, 12 bytes. */
  nonce: string
  /**
   * When the author wrote it, by the author's clock. Present from version 2,
   * and signed with the rest: the relay can delay an envelope but not re-date it.
   */
  createdAt?: number
}

export interface Envelope extends EnvelopeHeader {
  /** base64url AES-256-GCM ciphertext with tag appended. */
  ct: string
  /** base64url Ed25519 signature over `envelopeSignedBytes`. */
  sig: string
}

/**
 * Canonical header bytes, used both as the AEAD associated data and as the
 * prefix of the signed bytes. Fixed field order, explicit.
 */
export function headerBytes(header: EnvelopeHeader): Bytes {
  return utf8(
    [
      "synk/envelope/v1",
      String(header.v),
      header.kind,
      header.author,
      String(header.seq),
      header.resourceId,
      String(header.epoch),
      header.nonce,
      ...(header.v === 2 ? [String(header.createdAt)] : []),
    ].join("\n"),
  )
}

/** What the author signs: the whole header plus the ciphertext. */
export function envelopeSignedBytes(header: EnvelopeHeader, ct: string): Bytes {
  return utf8(`${new TextDecoder().decode(headerBytes(header))}\n${ct}`)
}

export interface MakeEnvelopeOptions {
  signingKey: SigningKey
  author: string
  seq: number
  resourceId: string
  epoch: number
  dek: Bytes
  /** The plaintext payload. */
  update: Bytes
  /** Defaults to "update". */
  kind?: EnvelopeKind
  /** Injectable for deterministic tests. */
  nonce?: Bytes
  createdAt?: number
}

export async function makeEnvelope(options: MakeEnvelopeOptions): Promise<Envelope> {
  const { signingKey, author, seq, resourceId, epoch, dek, update } = options
  if (!Number.isInteger(seq) || seq < 1) throw new Error("envelope seq must be a positive integer")

  const nonce = options.nonce ?? randomNonce()
  const header: EnvelopeHeader = {
    v: ENVELOPE_VERSION,
    kind: options.kind ?? "update",
    author,
    seq,
    resourceId,
    epoch,
    nonce: toBase64Url(nonce),
    createdAt: options.createdAt ?? Date.now(),
  }
  const ct = toBase64Url(await aeadEncrypt(dek, nonce, update, headerBytes(header)))
  return { ...header, ct, sig: toBase64Url(await signingKey.sign(envelopeSignedBytes(header, ct))) }
}

/** Strip the signature and ciphertext back to the header fields. */
export function envelopeHeader(envelope: Envelope): EnvelopeHeader {
  return {
    v: envelope.v,
    kind: envelope.kind,
    author: envelope.author,
    seq: envelope.seq,
    resourceId: envelope.resourceId,
    epoch: envelope.epoch,
    nonce: envelope.nonce,
    ...(envelope.v === 2 ? { createdAt: envelope.createdAt } : {}),
  }
}

/**
 * Signature check only. Never decrypt an envelope that fails this. Returns
 * false for every rejection - envelopes arrive from the network.
 */
export async function verifyEnvelopeSignature(
  envelope: Envelope,
  authorPublicKey: Bytes,
): Promise<boolean> {
  try {
    if (!isVersion(envelope.v)) return false
    if (envelope.v === 2 && !Number.isSafeInteger(envelope.createdAt)) return false
    if (!Number.isInteger(envelope.seq) || envelope.seq < 1) return false
    if (typeof envelope.ct !== "string" || typeof envelope.sig !== "string") return false
    if (fromBase64Url(envelope.nonce).length !== 12) return false

    const header = envelopeHeader(envelope)
    return await verifySignature(
      authorPublicKey,
      envelopeSignedBytes(header, envelope.ct),
      fromBase64Url(envelope.sig),
    )
  } catch {
    return false
  }
}

/**
 * Decrypt. Throws on failure, which is safe only because the signature has
 * already been checked - a failure here means we and the sender disagree about
 * the key or the framing, not that an attacker sent something.
 */
export async function openEnvelope(envelope: Envelope, dek: Bytes): Promise<Bytes> {
  return aeadDecrypt(
    dek,
    fromBase64Url(envelope.nonce),
    fromBase64Url(envelope.ct),
    headerBytes(envelopeHeader(envelope)),
  )
}

/** Cheap shape check before anything expensive. */
export function isEnvelopeShaped(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false
  const e = value as Partial<Envelope>
  return (
    isVersion(e.v) &&
    (e.v === 1 || typeof e.createdAt === "number") &&
    (e.kind === "update" || e.kind === "presence") &&
    typeof e.author === "string" &&
    typeof e.seq === "number" &&
    typeof e.resourceId === "string" &&
    typeof e.epoch === "number" &&
    typeof e.nonce === "string" &&
    typeof e.ct === "string" &&
    typeof e.sig === "string"
  )
}
