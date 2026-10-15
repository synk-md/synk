/**
 * The workspace directory: member keys, prekeys, invitations and redemptions,
 * carried as Yjs state.
 *
 * Yjs is the transport here, never the authority. Its merge is a convenience
 * for getting records to everyone; it decides nothing about what is true. Every
 * record is independently signed, and every read re-verifies from scratch. A
 * peer that writes garbage, replays an old record, or overwrites an entry with
 * a well-formed record of its own produces entries that simply fail
 * verification and are dropped.
 *
 * That is why the read API returns only verified records and takes the trusted
 * admin set as an argument. `rawEntries` exists for debugging and is the only
 * way to see unverified state; it is named to make its use obvious in review.
 */

import * as Y from "yjs"
import {
  adminDidsOf,
  keptOf,
  verifyAdmittedDevice,
  verifyDeviceRecord,
  verifyLinkedDevice,
  type AdmittedDevice,
  type DeviceAdmission,
  type DeviceLink,
  type DeviceRecord,
  type LinkedDevice,
  type AdminTrust,
  type MemberDevice,
  type VerifyAdmissionOptions,
} from "@/lib/identity"
import { verifyPrekeyBundle, type PrekeyBundle } from "./prekeys"
import {
  verifyInvitation,
  verifyRedemption,
  type Invitation,
  type Redemption,
} from "./invitation"
import {
  revokedInvitationIds,
  type InvitationRevocation,
} from "./invitation-revocation"
import { verifyDeviceRemoval, type DeviceRemoval } from "./device-removal"
import { verifyLinkRevocation, type LinkRevocation } from "@/lib/membership/link-revocation"
import { verifyRatification, type Ratification } from "./ratification"

/** Sub-maps of the directory document. */
export const DIRECTORY_MAPS = {
  devices: "directory:devices",
  admissions: "directory:admissions",
  links: "directory:links",
  prekeys: "directory:prekeys",
  invitations: "directory:invitations",
  invitationRevocations: "directory:invitation-revocations",
  redemptions: "directory:redemptions",
  removals: "directory:removals",
  linkRevocations: "directory:link-revocations",
  ratifications: "directory:ratifications",
} as const

export interface DirectoryReadOptions extends VerifyAdmissionOptions {
  now?: number
}

/**
 * Everything that survived verification. Records that failed are absent, and
 * `rejected` counts them so a caller can surface "some records were dropped"
 * rather than silently showing a shorter list.
 */
export interface VerifiedDirectory {
  devices: MemberDevice[]
  prekeys: Map<string, PrekeyBundle>
  /** Verified and not withdrawn. */
  invitations: Invitation[]
  /** Ids an admin has taken back, so a caller can say why one vanished. */
  revokedInvitations: Set<string>
  redemptions: Map<string, Redemption[]>
  /** Present once, then validly taken out - removed by an admin, or unlinked by its own member. Absent from `devices`. */
  removed: Set<string>
  /** Who may sign as an admin: those trusted, and their own linked devices. */
  admins: string[]
  /** Which admin each linked one acts as. */
  deputies: Map<string, string>
  /** What former deputies signed that an admin kept. */
  kept: ReadonlySet<string>
  rejected: number
}

function map<T>(doc: Y.Doc, name: string): Y.Map<T> {
  return doc.getMap<T>(name)
}

// ---------------------------------------------------------------------------
// Writing. Any peer may write; nothing here grants anything.
// ---------------------------------------------------------------------------

export function putDeviceRecord(doc: Y.Doc, record: DeviceRecord): void {
  map<DeviceRecord>(doc, DIRECTORY_MAPS.devices).set(record.did, record)
}

export function putAdmission(doc: Y.Doc, admission: DeviceAdmission): void {
  map<DeviceAdmission>(doc, DIRECTORY_MAPS.admissions).set(admission.did, admission)
}

export function putLinkRevocation(doc: Y.Doc, revocation: LinkRevocation): void {
  map<LinkRevocation>(doc, DIRECTORY_MAPS.linkRevocations).set(revocation.did, revocation)
}

export function putRemoval(doc: Y.Doc, removal: DeviceRemoval): void {
  map<DeviceRemoval>(doc, DIRECTORY_MAPS.removals).set(removal.did, removal)
}

/**
 * Dids with a removal on file, unverified. Only for deciding whether a
 * connection is worth opening, never for deciding who may do anything.
 */
export function removedDidsUnverified(doc: Y.Doc): Set<string> {
  return new Set(map<DeviceRemoval>(doc, DIRECTORY_MAPS.removals).keys())
}

/** Filed by device and time, so keeping more later adds rather than replaces. */
export function putRatification(doc: Y.Doc, ratification: Ratification): void {
  map<Ratification>(doc, DIRECTORY_MAPS.ratifications).set(
    `${ratification.device}@${String(ratification.at)}`,
    ratification,
  )
}

export function putLink(doc: Y.Doc, link: DeviceLink): void {
  map<DeviceLink>(doc, DIRECTORY_MAPS.links).set(link.did, link)
}

export function putPrekeyBundle(doc: Y.Doc, bundle: PrekeyBundle): void {
  map<PrekeyBundle>(doc, DIRECTORY_MAPS.prekeys).set(bundle.did, bundle)
}

export function putInvitationRevocation(doc: Y.Doc, revocation: InvitationRevocation): void {
  map<InvitationRevocation>(doc, DIRECTORY_MAPS.invitationRevocations).set(
    revocation.invitationId,
    revocation,
  )
}

export function putInvitation(doc: Y.Doc, invitation: Invitation): void {
  map<Invitation>(doc, DIRECTORY_MAPS.invitations).set(invitation.invitationId, invitation)
}

/**
 * Redemptions are appended per invitation rather than keyed singly, because
 * seeing a *second* redemption is the signal that an invitation was reused.
 * Overwriting would hide exactly what single-use enforcement needs to notice.
 */
export function putRedemption(doc: Y.Doc, redemption: Redemption): void {
  const store = map<Redemption[]>(doc, DIRECTORY_MAPS.redemptions)
  const existing = store.get(redemption.invitationId) ?? []
  if (existing.some((prior) => prior.sig === redemption.sig)) return
  store.set(redemption.invitationId, [...existing, redemption])
}

// ---------------------------------------------------------------------------
// Reading. Everything is re-verified.
// ---------------------------------------------------------------------------

/**
 * Read and verify the whole directory.
 *
 * Device presence is resolved exactly as `verifyUser` does it: an admission
 * from a trusted admin, or a link whose parent is an admin-admitted device of
 * the same member, resolved from within this directory.
 */
export async function readDirectory(
  doc: Y.Doc,
  trustedAdminDids: AdminTrust,
  options: DirectoryReadOptions = {},
): Promise<VerifiedDirectory> {
  const base = adminDidsOf(trustedAdminDids)
  const kept = new Set(keptOf(trustedAdminDids))
  for (const ratification of map<Ratification>(doc, DIRECTORY_MAPS.ratifications).values()) {
    if (await verifyRatification(ratification, base, options)) {
      for (const signature of ratification.kept) kept.add(signature)
    }
  }

  // An admin's own linked devices act as that admin: the owner's phone is the
  // owner. Found with the admins alone, then read again with them added -
  // links rest on admissions, so the second read cannot change who they are.
  const first = await readWith(doc, { dids: base, kept }, options)
  const deputies = new Map<string, string>()
  for (const device of first.devices) {
    if (device.kind === "linked" && base.includes(device.link.parent)) deputies.set(device.record.did, device.link.parent)
  }
  const admins = [...base, ...deputies.keys()]
  const read = deputies.size === 0 ? first : await readWith(doc, { dids: admins, kept }, options)
  return { ...read, admins, deputies, kept }
}

async function readWith(
  doc: Y.Doc,
  trustedAdminDids: AdminTrust,
  options: DirectoryReadOptions,
): Promise<Omit<VerifiedDirectory, "admins" | "deputies" | "kept">> {
  const now = options.now ?? Date.now()
  let rejected = 0

  const records = new Map<string, DeviceRecord>()
  for (const [did, record] of map<DeviceRecord>(doc, DIRECTORY_MAPS.devices).entries()) {
    // A record filed under a DID other than its own is a misfiled or hostile
    // entry; the key is part of what is being asserted.
    if (record?.did === did && (await verifyDeviceRecord(record))) records.set(did, record)
    else rejected += 1
  }

  // Admissions first: links can only be rooted in an admitted parent.
  const admitted = new Map<string, AdmittedDevice>()
  const removals = map<DeviceRemoval>(doc, DIRECTORY_MAPS.removals)
  const removed = new Set<string>()
  for (const [did, admission] of map<DeviceAdmission>(doc, DIRECTORY_MAPS.admissions).entries()) {
    const record = records.get(did)
    if (!record || admission?.did !== did) {
      rejected += 1
      continue
    }
    const device: AdmittedDevice = { record, admission }
    if (!(await verifyAdmittedDevice(device, trustedAdminDids, options))) {
      rejected += 1
      continue
    }
    // Removed is not rejected: the admission was real, and an admin ended it.
    // Leaving it out here is what stops everything built on the directory -
    // the author check, the member list - from honouring it.
    const removal = removals.get(did)
    if (removal && (await verifyDeviceRemoval(removal, admission, trustedAdminDids))) {
      removed.add(did)
      continue
    }
    admitted.set(did, device)
  }

  const linked: LinkedDevice[] = []
  const revocations = map<LinkRevocation>(doc, DIRECTORY_MAPS.linkRevocations)
  const admittedDevices = [...admitted.values()].map((device) => ({ kind: "admitted" as const, ...device }))
  for (const [did, link] of map<DeviceLink>(doc, DIRECTORY_MAPS.links).entries()) {
    const record = records.get(did)
    const parent = link ? admitted.get(link.parent) : undefined
    if (!record || !parent || link.did !== did) {
      rejected += 1
      continue
    }
    const device: LinkedDevice = { record, link }
    if (!(await verifyLinkedDevice(device, parent, trustedAdminDids, options))) {
      rejected += 1
      continue
    }
    // Unlinked by one of the member's own admitted devices - a lost phone. It
    // applies to links issued before it, so the device can be linked again.
    const revocation = revocations.get(did)
    if (
      revocation &&
      revocation.revokedAt >= link.issuedAt &&
      (await verifyLinkRevocation(revocation, link, admittedDevices))
    ) {
      removed.add(did)
      continue
    }
    linked.push(device)
  }

  const devices: MemberDevice[] = [
    ...[...admitted.values()].map((device) => ({ kind: "admitted" as const, ...device })),
    ...linked.map((device) => ({ kind: "linked" as const, ...device })),
  ]

  const prekeys = new Map<string, PrekeyBundle>()
  for (const [did, bundle] of map<PrekeyBundle>(doc, DIRECTORY_MAPS.prekeys).entries()) {
    // Only devices that are actually present may publish a sealing target.
    const present = admitted.has(did) || linked.some((device) => device.record.did === did)
    if (present && bundle?.did === did && (await verifyPrekeyBundle(bundle, { now })))
      prekeys.set(did, bundle)
    else rejected += 1
  }

  const signedInvitations: Invitation[] = []
  for (const [id, invitation] of map<Invitation>(doc, DIRECTORY_MAPS.invitations).entries()) {
    if (
      invitation?.invitationId === id &&
      (await verifyInvitation(invitation, trustedAdminDids, { ...options, now }))
    ) {
      signedInvitations.push(invitation)
    } else rejected += 1
  }

  // A withdrawn invitation is not a rejected record - it verified, and an admin
  // took it back. It simply stops being offered.
  const revoked = await revokedInvitationIds(
    [...map<InvitationRevocation>(doc, DIRECTORY_MAPS.invitationRevocations).values()],
    signedInvitations,
    trustedAdminDids,
  )
  const invitations = signedInvitations.filter(
    (invitation) => !revoked.has(invitation.invitationId),
  )

  const byId = new Map(invitations.map((invitation) => [invitation.invitationId, invitation]))
  const redemptions = new Map<string, Redemption[]>()
  for (const [id, entries] of map<Redemption[]>(doc, DIRECTORY_MAPS.redemptions).entries()) {
    const invitation = byId.get(id)
    if (!invitation || !Array.isArray(entries)) {
      rejected += 1
      continue
    }
    const valid: Redemption[] = []
    for (const redemption of entries) {
      if (await verifyRedemption(redemption, invitation, { now })) valid.push(redemption)
      else rejected += 1
    }
    if (valid.length > 0) redemptions.set(id, valid)
  }

  return { devices, prekeys, invitations, revokedInvitations: revoked, redemptions, removed, rejected }
}

/**
 * Redemptions recorded against one invitation, verified.
 *
 * More than one naming different devices means the invitation was reused; the
 * grant path refuses in that case rather than picking a winner.
 */
export async function redemptionsFor(
  doc: Y.Doc,
  invitationId: string,
  trustedAdminDids: AdminTrust,
  options: DirectoryReadOptions = {},
): Promise<Redemption[]> {
  const directory = await readDirectory(doc, trustedAdminDids, options)
  return directory.redemptions.get(invitationId) ?? []
}

/** Where to seal to this device, or undefined if it published no usable bundle. */
export function sealingBundleFor(
  directory: VerifiedDirectory,
  did: string,
): PrekeyBundle | undefined {
  return directory.prekeys.get(did)
}

/**
 * Raw, **unverified** state. For debugging and tests only - never build a
 * decision on this. Named so its use stands out in review.
 */
export function rawEntries(doc: Y.Doc, mapName: string): [string, unknown][] {
  return [...doc.getMap<unknown>(mapName).entries()]
}
