/**
 * Shared fixtures for the identity tests.
 *
 * Building an admitted or linked device takes several correlated steps - key
 * generation, a self-signed record, an admin admission, sometimes a parent link
 * - and getting one step subtly wrong in a test makes the test pass for the
 * wrong reason. Centralised so every suite exercises the same construction the
 * real code would produce, and so a test that deviates does so visibly.
 */

import { generateSealingKey, generateSigningKey, type SigningKey } from "@/lib/crypto"
import {
  createDeviceAdmission,
  createDeviceLink,
  createDeviceRecord,
  didFromSigningKey,
  type AdmittedDevice,
  type DeviceRecord,
  type LinkedDevice,
  type MemberDevice,
} from "@/lib/identity"

export const WORKSPACE = "workspace:acme"

export interface Admin {
  key: SigningKey
  did: string
}

export async function newAdmin(): Promise<Admin> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

/** A fresh device: its signing key plus a verifying self-signed record. */
export async function newDevice(): Promise<{ key: SigningKey; record: DeviceRecord }> {
  const key = await generateSigningKey()
  const record = await createDeviceRecord(key, await generateSealingKey())
  return { key, record }
}

export async function newDeviceRecord(): Promise<DeviceRecord> {
  return (await newDevice()).record
}

/** A device admitted directly by an admin - how a new person joins. */
export async function admitDevice(
  admin: Admin,
  options: { member?: string; label?: string; workspace?: string; issuedAt?: number } = {},
): Promise<AdmittedDevice & { key: SigningKey }> {
  const { key, record } = await newDevice()
  const admission = await createDeviceAdmission({
    adminSigningKey: admin.key,
    adminDid: admin.did,
    record,
    member: options.member ?? "member:maren",
    label: options.label ?? "Maren",
    workspace: options.workspace ?? WORKSPACE,
    issuedAt: options.issuedAt ?? 1_700_000_000_000,
  })
  return { key, record, admission }
}

/** A device the member linked themselves from an admin-admitted parent. */
export async function linkDevice(
  parent: AdmittedDevice & { key: SigningKey },
  options: { issuedAt?: number } = {},
): Promise<LinkedDevice & { key: SigningKey }> {
  const { key, record } = await newDevice()
  const link = await createDeviceLink({
    parentSigningKey: parent.key,
    parentAdmission: parent.admission,
    record,
    issuedAt: options.issuedAt ?? 1_700_000_100_000,
  })
  return { key, record, link }
}

export function asAdmitted(device: AdmittedDevice): MemberDevice {
  return { kind: "admitted", record: device.record, admission: device.admission }
}

export function asLinked(device: LinkedDevice): MemberDevice {
  return { kind: "linked", record: device.record, link: device.link }
}
