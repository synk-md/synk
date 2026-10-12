/**
 * Taking a device out of a workspace.
 *
 * Its own signed record rather than deleting the admission. A deletion is
 * undone by anything that copies records it does not see - a peer that missed
 * it, or the migration that moves records into the directory document - and a
 * member who reappears after being removed is the failure that matters most.
 * A record can only ever be added, so it cannot be lost that way.
 *
 * It applies to admissions issued before it, so the same device can be invited
 * back later without the old removal standing in the way.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid, type DeviceAdmission } from "@/lib/identity"

export const DEVICE_REMOVAL_VERSION = 1

export interface DeviceRemovalBody {
  v: typeof DEVICE_REMOVAL_VERSION
  /** `did:key` of the device being removed. */
  did: string
  member: string
  workspace: string
  /** `did:key` of the admin removing it. */
  admin: string
  reason?: string
  removedAt: number
}

export interface DeviceRemoval extends DeviceRemovalBody {
  sig: string
}

export function deviceRemovalBytes(body: DeviceRemovalBody): Bytes {
  return utf8(
    [
      "synk/device-removal/v1",
      String(body.v),
      body.did,
      body.member,
      body.workspace,
      body.admin,
      body.reason ?? "",
      String(body.removedAt),
    ].join("\n"),
  )
}

export interface RemoveDeviceOptions {
  signingKey: SigningKey
  admin: string
  admission: DeviceAdmission
  reason?: string
  removedAt?: number
}

export async function removeDevice(options: RemoveDeviceOptions): Promise<DeviceRemoval> {
  const adminKey = publicKeyFromDid(options.admin, "ed25519")
  if (toBase64Url(adminKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("admin does not match the supplied signing key")
  }
  const body: DeviceRemovalBody = {
    v: DEVICE_REMOVAL_VERSION,
    did: options.admission.did,
    member: options.admission.member,
    workspace: options.admission.workspace,
    admin: options.admin,
    removedAt: options.removedAt ?? Date.now(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(deviceRemovalBytes(body))) }
}

/**
 * Authentic, from a trusted admin, about this admission, and not older than it.
 *
 * Without the admin check anyone holding the link could remove anyone, which
 * is the cheapest denial of service there is.
 */
export async function verifyDeviceRemoval(
  removal: DeviceRemoval,
  admission: DeviceAdmission,
  trustedAdminDids: readonly string[],
): Promise<boolean> {
  try {
    if (removal.v !== DEVICE_REMOVAL_VERSION) return false
    if (removal.did !== admission.did) return false
    if (removal.workspace !== admission.workspace) return false
    if (removal.removedAt < admission.issuedAt) return false
    if (!trustedAdminDids.includes(removal.admin)) return false

    const { sig, ...body } = removal
    return await verifySignature(
      publicKeyFromDid(removal.admin, "ed25519"),
      deviceRemovalBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}
