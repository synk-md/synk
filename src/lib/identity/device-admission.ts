/**
 * Admin-signed admission of a new person into a workspace.
 *
 * The admin half of the split admission model; `device-link.ts` holds the
 * self-service half. An admission names the device key, the member it belongs
 * to, and the admin-attested human label.
 *
 * Admin-only is structural: producing one requires an admin signing key, and
 * verifying one requires naming the admins you trust.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { deriveClientId } from "./client-id"
import { publicKeyFromDid } from "./did"
import { trustsAdmin, type AdminTrust } from "./admin-trust"
import { verifyDeviceRecord, type DeviceRecord } from "./device-record"

export const DEVICE_ADMISSION_VERSION = 1

export interface DeviceAdmissionBody {
  v: typeof DEVICE_ADMISSION_VERSION
  /** `did:key` of the admitted device's signing key. */
  did: string
  /** The sealing key the admin attests belongs to that device. */
  sealingDid: string
  /** Derived client id, re-checked on verify so an admin cannot mis-state it. */
  clientId: number
  /**
   * The member this key belongs to. Self-linked devices inherit this value, so
   * every key a person holds attributes back to one member identity regardless
   * of which path admitted it.
   */
  member: string
  /** Admin-attested human label. The only trustworthy display name. */
  label: string
  /** Scope of the admission - the workspace or notebook this key is admitted to. */
  workspace: string
  /** `did:key` of the admitting admin. */
  admin: string
  issuedAt: number
}

export interface DeviceAdmission extends DeviceAdmissionBody {
  /** base64url Ed25519 signature by `admin` over `admissionBytes(body)`. */
  sig: string
}

/** A device admitted directly by an admin. Proven possession plus authority. */
export interface AdmittedDevice {
  record: DeviceRecord
  admission: DeviceAdmission
}

/**
 * The exact bytes an admin signs. Fixed field order, explicit, no
 * `JSON.stringify` - see the same reasoning in `device-record.ts`.
 */
export function admissionBytes(body: DeviceAdmissionBody): Bytes {
  return utf8(
    [
      "synk/device-admission/v1",
      String(body.v),
      body.did,
      body.sealingDid,
      String(body.clientId),
      body.member,
      body.label,
      body.workspace,
      body.admin,
      String(body.issuedAt),
    ].join("\n"),
  )
}

export interface CreateDeviceAdmissionOptions {
  adminSigningKey: SigningKey
  adminDid: string
  /** The new member's first device, with possession already proven. */
  record: DeviceRecord
  /** Member identity this key is admitted under. */
  member: string
  label: string
  workspace: string
  issuedAt?: number
}

/**
 * Admit a new person. Requires an admin's signing key - there is no other entry
 * point, which is what makes "new people are admin-only" structural.
 *
 * The device's own self-signed record is the input rather than loose fields, so
 * an admin cannot admit a key whose possession was never demonstrated, and the
 * sealing key and client id are copied from a record that has already been
 * verified rather than retyped.
 */
export async function createDeviceAdmission(
  options: CreateDeviceAdmissionOptions,
): Promise<DeviceAdmission> {
  const { adminSigningKey, adminDid, record, member, label, workspace } = options

  if (!(await verifyDeviceRecord(record))) {
    throw new Error("cannot admit a device whose self-signed record does not verify")
  }
  if (!label.trim()) throw new Error("a device admission must carry a non-empty human label")
  if (!member.trim()) throw new Error("a device admission must name a member")

  // The admin DID must be the key actually signing, or the admission would name
  // one admin and be signed by another.
  const adminPublicKey = publicKeyFromDid(adminDid, "ed25519")
  if (toBase64Url(adminPublicKey) !== toBase64Url(adminSigningKey.publicKey)) {
    throw new Error("adminDid does not match the supplied admin signing key")
  }

  const body: DeviceAdmissionBody = {
    v: DEVICE_ADMISSION_VERSION,
    did: record.did,
    sealingDid: record.sealingDid,
    clientId: record.clientId,
    member: member.trim(),
    label: label.trim(),
    workspace,
    admin: adminDid,
    issuedAt: options.issuedAt ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await adminSigningKey.sign(admissionBytes(body))) }
}

export interface VerifyAdmissionOptions {
  /** Restrict to a single workspace. Omit to accept any scope. */
  workspace?: string
}

/**
 * Verify an admission against an explicit set of trusted admins.
 *
 * The admin set is required, not optional. There is deliberately no way to
 * verify an admission "in a vacuum" - that API shape would make it easy to
 * accept a self-signed admission from the very device being admitted, which
 * would turn the admin-only path into self-service by accident.
 */
export async function verifyDeviceAdmission(
  admission: DeviceAdmission,
  trustedAdminDids: AdminTrust,
  options: VerifyAdmissionOptions = {},
): Promise<boolean> {
  try {
    if (admission.v !== DEVICE_ADMISSION_VERSION) return false
    if (!admission.label.trim()) return false
    if (!admission.member.trim()) return false
    if (options.workspace !== undefined && admission.workspace !== options.workspace) return false
    if (!trustsAdmin(trustedAdminDids, admission.admin, admission.sig)) return false

    const devicePublicKey = publicKeyFromDid(admission.did, "ed25519")
    // Throws if the sealing slot holds a signing key or a malformed DID.
    publicKeyFromDid(admission.sealingDid, "x25519")

    // An admin cannot grant a device a client id it is not entitled to, even by
    // mistake: the value is re-derived from the admitted key itself.
    if (admission.clientId !== (await deriveClientId(devicePublicKey))) return false

    const adminPublicKey = publicKeyFromDid(admission.admin, "ed25519")
    const { sig, ...body } = admission
    return await verifySignature(adminPublicKey, admissionBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

/**
 * The full check for an admin-admitted device: possession proven, admission
 * valid, and the two agreeing.
 *
 * The agreement check matters. A valid record and a valid admission that name
 * different sealing keys would mean an admin vouched for a key the device does
 * not hold - epoch keys sealed there would be unreadable, and the mismatch
 * would otherwise surface as a silent decryption failure much later.
 */
export async function verifyAdmittedDevice(
  device: AdmittedDevice,
  trustedAdminDids: AdminTrust,
  options: VerifyAdmissionOptions = {},
): Promise<boolean> {
  const { record, admission } = device
  if (record.did !== admission.did) return false
  if (record.sealingDid !== admission.sealingDid) return false
  if (record.clientId !== admission.clientId) return false
  if (!(await verifyDeviceRecord(record))) return false
  return verifyDeviceAdmission(admission, trustedAdminDids, options)
}

/** The admin-attested label, the only display name that carries any weight. */
export function attestedLabel(device: AdmittedDevice): string {
  return device.admission.label
}
