/**
 * Self-service linking: a member's admin-admitted device signing a delegation
 * to another key of their own - second browser, phone, reinstalled profile.
 *
 * The link is a non-delegable leaf: depth 0, inheriting member and workspace
 * from the parent's admission, carrying no label. So it can add keys but never
 * widen scope, rename the member, or delegate onward.
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
import { verifyDeviceRecord, type DeviceRecord } from "./device-record"
import {
  verifyAdmittedDevice,
  type AdmittedDevice,
  type VerifyAdmissionOptions,
} from "./device-admission"

export const DEVICE_LINK_VERSION = 1

/** Non-delegable. A linked device may not sign further links. */
export const LEAF_DEPTH = 0

export interface DeviceLinkBody {
  v: typeof DEVICE_LINK_VERSION
  /** `did:key` of the newly linked device's signing key. */
  did: string
  sealingDid: string
  clientId: number
  /** Inherited from the parent's admission. Never chosen here. */
  member: string
  /** Inherited from the parent's admission. Never widened here. */
  workspace: string
  /** `did:key` of the admin-admitted device signing this link. */
  parent: string
  /** Always `LEAF_DEPTH`. Present explicitly so a non-zero value is rejected. */
  depth: typeof LEAF_DEPTH
  issuedAt: number
}

export interface DeviceLink extends DeviceLinkBody {
  /** base64url Ed25519 signature by `parent` over `linkBytes(body)`. */
  sig: string
}

/** A device present by self-link rather than admin admission. */
export interface LinkedDevice {
  record: DeviceRecord
  link: DeviceLink
}

/** The exact bytes a parent device signs. Fixed order, explicit. */
export function linkBytes(body: DeviceLinkBody): Bytes {
  return utf8(
    [
      "synk/device-link/v1",
      String(body.v),
      body.did,
      body.sealingDid,
      String(body.clientId),
      body.member,
      body.workspace,
      body.parent,
      String(body.depth),
      String(body.issuedAt),
    ].join("\n"),
  )
}

export interface CreateDeviceLinkOptions {
  /** Signing key of the already-admitted device performing the link. */
  parentSigningKey: SigningKey
  /** That device's admin admission - the source of `member` and `workspace`. */
  parentAdmission: AdmittedDevice["admission"]
  /** The new device, with possession already proven. */
  record: DeviceRecord
  issuedAt?: number
}

/**
 * Link a new key to an existing member.
 *
 * Takes the parent's *admission*, not loose fields, so `member` and `workspace`
 * are copied from an admin's attestation rather than supplied by the caller -
 * there is no parameter through which a link could claim a different member or
 * a wider scope.
 */
export async function createDeviceLink(options: CreateDeviceLinkOptions): Promise<DeviceLink> {
  const { parentSigningKey, parentAdmission, record } = options

  if (!(await verifyDeviceRecord(record))) {
    throw new Error("cannot link a device whose self-signed record does not verify")
  }
  // The parent must be the key actually signing, or the link would name one
  // parent and be signed by another.
  const parentPublicKey = publicKeyFromDid(parentAdmission.did, "ed25519")
  if (toBase64Url(parentPublicKey) !== toBase64Url(parentSigningKey.publicKey)) {
    throw new Error("parentAdmission does not match the supplied parent signing key")
  }
  if (record.did === parentAdmission.did) {
    throw new Error("a device cannot link itself")
  }

  const body: DeviceLinkBody = {
    v: DEVICE_LINK_VERSION,
    did: record.did,
    sealingDid: record.sealingDid,
    clientId: record.clientId,
    member: parentAdmission.member,
    workspace: parentAdmission.workspace,
    parent: parentAdmission.did,
    depth: LEAF_DEPTH,
    issuedAt: options.issuedAt ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await parentSigningKey.sign(linkBytes(body))) }
}

/**
 * Verify a link against the parent that signed it.
 *
 * The parent is required and must itself be admin-admitted by a trusted admin.
 * That is what keeps the self-service path rooted: a link is only as good as
 * the admission behind it, and a link signed by a device nobody admitted
 * verifies against nothing.
 */
export async function verifyDeviceLink(
  link: DeviceLink,
  parent: AdmittedDevice,
  trustedAdminDids: readonly string[],
  options: VerifyAdmissionOptions = {},
): Promise<boolean> {
  try {
    if (link.v !== DEVICE_LINK_VERSION) return false
    // Non-delegable leaf. A link claiming any other depth is rejected outright
    // rather than clamped, because the claim itself signals a different model.
    if (link.depth !== LEAF_DEPTH) return false
    if (!link.member.trim()) return false
    if (link.parent !== parent.admission.did) return false
    if (link.did === link.parent) return false

    // Scope and identity must be inherited exactly, never widened.
    if (link.member !== parent.admission.member) return false
    if (link.workspace !== parent.admission.workspace) return false
    if (options.workspace !== undefined && link.workspace !== options.workspace) return false

    const devicePublicKey = publicKeyFromDid(link.did, "ed25519")
    publicKeyFromDid(link.sealingDid, "x25519")
    if (link.clientId !== (await deriveClientId(devicePublicKey))) return false

    // The parent must hold a real admin admission. Checked here rather than
    // assumed, so a caller cannot root a link on an unverified parent.
    if (!(await verifyAdmittedDevice(parent, trustedAdminDids, options))) return false

    const parentPublicKey = publicKeyFromDid(link.parent, "ed25519")
    const { sig, ...body } = link
    return await verifySignature(parentPublicKey, linkBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

/** Possession proven, link valid against an admitted parent, and the two agreeing. */
export async function verifyLinkedDevice(
  device: LinkedDevice,
  parent: AdmittedDevice,
  trustedAdminDids: readonly string[],
  options: VerifyAdmissionOptions = {},
): Promise<boolean> {
  const { record, link } = device
  if (record.did !== link.did) return false
  if (record.sealingDid !== link.sealingDid) return false
  if (record.clientId !== link.clientId) return false
  if (!(await verifyDeviceRecord(record))) return false
  return verifyDeviceLink(link, parent, trustedAdminDids, options)
}
