/**
 * The self-signed device record: proof that a device controls its key pair.
 *
 * Necessary but not sufficient - anyone can mint one for their own key, so
 * authority comes from a `DeviceAdmission` or `DeviceLink` on top.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
  type SealingKey,
} from "@/lib/crypto"
import { deriveClientId } from "./client-id"
import { didFromSealingKey, didFromSigningKey, publicKeyFromDid } from "./did"

export const DEVICE_RECORD_VERSION = 1

export interface DeviceRecordBody {
  v: typeof DEVICE_RECORD_VERSION
  /** `did:key` of the Ed25519 signing key. The device's identifier. */
  did: string
  /** `did:key` of the X25519 sealing key. Where epoch keys are sealed. */
  sealingDid: string
  /** The Yjs client id this device may use, derived from `did`. */
  clientId: number
  /** Milliseconds since the epoch, for display and tie-breaking only. */
  createdAt: number
}

export interface DeviceRecord extends DeviceRecordBody {
  /** base64url Ed25519 signature over `canonicalBytes(body)`. */
  sig: string
}

/**
 * The exact bytes that get signed.
 *
 * Built field by field in a fixed order rather than via `JSON.stringify`, so
 * the signed form cannot shift under a different serialiser, a reordered
 * object literal, or an added field. A verifier reconstructs these bytes
 * independently; if the two ever disagree, every signature silently fails,
 * which is why this function is deliberately dull and explicit.
 */
export function canonicalBytes(body: DeviceRecordBody): Bytes {
  return utf8(
    [
      "synk/device-record/v1",
      String(body.v),
      body.did,
      body.sealingDid,
      String(body.clientId),
      String(body.createdAt),
    ].join("\n"),
  )
}

export interface CreateDeviceRecordOptions {
  /** Defaults to now. Injectable so tests are deterministic. */
  createdAt?: number
}

/** Build and self-sign a device record for a freshly generated key pair set. */
export async function createDeviceRecord(
  signingKey: SigningKey,
  sealingKey: SealingKey,
  options: CreateDeviceRecordOptions = {},
): Promise<DeviceRecord> {
  const body: DeviceRecordBody = {
    v: DEVICE_RECORD_VERSION,
    did: didFromSigningKey(signingKey.publicKey),
    sealingDid: didFromSealingKey(sealingKey.publicKey),
    clientId: await deriveClientId(signingKey.publicKey),
    createdAt: options.createdAt ?? Date.now(),
  }
  const sig = toBase64Url(await signingKey.sign(canonicalBytes(body)))
  return { ...body, sig }
}

/**
 * Verify a record end to end. False rather than throwing - records arrive from
 * the network and callers uniformly drop failures. The client-id check carries
 * the attribution guarantee: a device cannot mint itself a record claiming an
 * id its own key does not derive.
 */
export async function verifyDeviceRecord(record: DeviceRecord): Promise<boolean> {
  try {
    if (record.v !== DEVICE_RECORD_VERSION) return false

    const signingPublicKey = publicKeyFromDid(record.did, "ed25519")
    // Throws on a malformed or wrong-type sealing DID; a record that names a
    // signing key where a sealing key belongs is not merely useless, it is a
    // sign the record was assembled by something other than our own code.
    publicKeyFromDid(record.sealingDid, "x25519")

    if (record.clientId !== (await deriveClientId(signingPublicKey))) return false

    const { sig, ...body } = record
    return await verifySignature(signingPublicKey, canonicalBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

/** The signing public key a verified record names. */
export function signingPublicKeyOf(record: DeviceRecord): Bytes {
  return publicKeyFromDid(record.did, "ed25519")
}

/** The sealing public key a verified record names - where to seal epoch keys. */
export function sealingPublicKeyOf(record: DeviceRecord): Bytes {
  return publicKeyFromDid(record.sealingDid, "x25519")
}
