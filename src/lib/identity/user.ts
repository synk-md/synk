/**
 * A member as a set of device keys, each present either by admin admission or
 * by a self-signed link from one of their admitted devices.
 *
 * Verification is set-level: a linked device is only valid alongside the parent
 * that signed it, resolved from within this user's own set. A `User` grants
 * nothing - authorisation is always evaluated against a device key.
 */

import { assertNoClientIdCollision } from "./client-id"
import type { DeviceRecord } from "./device-record"
import {
  verifyAdmittedDevice,
  type AdmittedDevice,
  type VerifyAdmissionOptions,
} from "./device-admission"
import { verifyLinkedDevice, type LinkedDevice } from "./device-link"

export type MemberDevice =
  | ({ kind: "admitted" } & AdmittedDevice)
  | ({ kind: "linked" } & LinkedDevice)

export interface User {
  /** Stable local identifier. Not a credential and not verifiable. */
  userId: string
  devices: MemberDevice[]
}

/** The device record, whichever path the device arrived by. */
export function recordOf(device: MemberDevice): DeviceRecord {
  return device.record
}

/** The member identity this device belongs to, from admission or inherited by link. */
export function memberOf(device: MemberDevice): string {
  return device.kind === "admitted" ? device.admission.member : device.link.member
}

function clientIds(devices: readonly MemberDevice[]): number[] {
  return devices.map((device) => device.record.clientId)
}

export function createUser(userId: string, devices: MemberDevice[] = []): User {
  assertNoClientIdCollision(clientIds(devices))
  return { userId, devices }
}

/** Add a device, replacing any existing entry for the same `did`. */
export function addDevice(user: User, device: MemberDevice): User {
  const devices = [
    ...user.devices.filter((existing) => existing.record.did !== device.record.did),
    device,
  ]
  assertNoClientIdCollision(clientIds(devices))
  return { ...user, devices }
}

export function removeDevice(user: User, did: string): User {
  return { ...user, devices: user.devices.filter((device) => device.record.did !== did) }
}

export function hasDevice(user: User, did: string): boolean {
  return user.devices.some((device) => device.record.did === did)
}

export function findDeviceByDid(user: User, did: string): MemberDevice | undefined {
  return user.devices.find((device) => device.record.did === did)
}

/**
 * Resolve a Yjs client id to the device that owns it.
 *
 * The lookup attribution (M9) depends on. Sound only because the client id is
 * derived from the device key rather than claimed, so neither the device, the
 * admitting admin, nor a linking parent can put a value here the key does not
 * produce.
 */
export function findDeviceByClientId(user: User, clientId: number): MemberDevice | undefined {
  return user.devices.find((device) => device.record.clientId === clientId)
}

/** Only admin-admitted devices may sign links, so these are the eligible parents. */
export function admittedDevices(user: User): AdmittedDevice[] {
  return user.devices.filter(
    (device): device is { kind: "admitted" } & AdmittedDevice => device.kind === "admitted",
  )
}

/**
 * Can this member still self-link a new device?
 *
 * False once every admin-admitted device is gone, even if linked ones remain -
 * links are non-delegable leaves. That is the designed fallback to admin
 * re-admission, and worth surfacing in the interface before a member is
 * stranded rather than after.
 */
export function canSelfLink(user: User): boolean {
  return admittedDevices(user).length > 0
}

/**
 * The admin-attested label, as a value rather than an exception - this is read
 * on render paths, and one conflicting admission must not take down every view
 * containing that byline. A conflict is surfaced, never resolved by picking a
 * winner. Labels are sorted so a conflicted render is stable.
 */
export type UserLabel =
  | { status: "none" }
  | { status: "attested"; label: string }
  | { status: "conflicted"; labels: readonly string[] }

export function userLabel(user: User): UserLabel {
  const labels = [...new Set(admittedDevices(user).map((device) => device.admission.label))].sort()
  if (labels.length === 0) return { status: "none" }
  if (labels.length > 1) return { status: "conflicted", labels }
  return { status: "attested", label: labels[0] }
}

/**
 * Strict variant for paths that are not rendering - an import, a migration, or
 * an operator tool where a conflict should stop the operation rather than be
 * displayed. Never call this from a component.
 */
export function userLabelOrThrow(user: User): string | undefined {
  const result = userLabel(user)
  if (result.status === "conflicted") {
    throw new Error(
      `conflicting admin-attested labels for user "${user.userId}": ${result.labels
        .map((label) => JSON.stringify(label))
        .join(", ")}`,
    )
  }
  return result.status === "attested" ? result.label : undefined
}

/**
 * Every device proves possession and is present by a valid path: an admission
 * from a trusted admin, or a link from an admin-admitted device of this same
 * member. No two devices share a client id.
 *
 * The admin set is required for the same reason it is on
 * `verifyDeviceAdmission`: a user is only as trustworthy as the authority
 * behind it, and there is no safe default set.
 */
export async function verifyUser(
  user: User,
  trustedAdminDids: readonly string[],
  options: VerifyAdmissionOptions = {},
): Promise<boolean> {
  try {
    assertNoClientIdCollision(clientIds(user.devices))
  } catch {
    return false
  }

  const parents = new Map(admittedDevices(user).map((device) => [device.admission.did, device]))

  const results = await Promise.all(
    user.devices.map(async (device) => {
      if (device.kind === "admitted") {
        return verifyAdmittedDevice(device, trustedAdminDids, options)
      }
      // Resolved from this user's own set, so a link cannot borrow a parent
      // from another member to justify itself.
      const parent = parents.get(device.link.parent)
      if (!parent) return false
      return verifyLinkedDevice(device, parent, trustedAdminDids, options)
    }),
  )
  return results.every(Boolean)
}

/** Search a set of users for the one owning a device. */
export function findUserByDeviceDid(users: readonly User[], did: string): User | undefined {
  return users.find((user) => hasDevice(user, did))
}
