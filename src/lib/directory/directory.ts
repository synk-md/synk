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

/**
 * Where a signed record is filed: under what it is about and its own
 * signature. Two records about one thing - a device admitted again, an epoch
 * two admins cut at once - each keep a slot of their own, so a write can add a
 * record and never replace one. What a record is about is read from the
 * record; the key decides nothing.
 */
export function slotFor(subject: string, sig: string): string {
  return `${subject}|${sig}`
}

/** Every record in a map, whatever it is filed under. */
export function valuesIn<T>(doc: Y.Doc, name: string): T[] {
  return [...map<T>(doc, name).values()].filter((value) => typeof value === "object" && value !== null)
}

function put<T extends { sig: string }>(doc: Y.Doc, name: string, subject: string, record: T): void {
  map<T>(doc, name).set(slotFor(subject, record.sig), record)
}

/** Newest first, then by signature, so every device picks the same one. */
function newestFirst<T extends { sig: string }>(records: readonly T[], at: (record: T) => number): T[] {
  return [...records].sort((a, b) => at(b) - at(a) || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
}

function bySubject<T>(records: readonly T[], subject: (record: T) => unknown): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const record of records) {
    const key = subject(record)
    if (typeof key !== "string") continue
    const bucket = out.get(key)
    if (bucket) bucket.push(record)
    else out.set(key, [record])
  }
  return out
}

// ---------------------------------------------------------------------------
// Writing. Any peer may write; nothing here grants anything.
// ---------------------------------------------------------------------------

export function putDeviceRecord(doc: Y.Doc, record: DeviceRecord): void {
  put(doc, DIRECTORY_MAPS.devices, record.did, record)
}

export function putAdmission(doc: Y.Doc, admission: DeviceAdmission): void {
  put(doc, DIRECTORY_MAPS.admissions, admission.did, admission)
}

export function putLinkRevocation(doc: Y.Doc, revocation: LinkRevocation): void {
  put(doc, DIRECTORY_MAPS.linkRevocations, revocation.did, revocation)
}

export function putRemoval(doc: Y.Doc, removal: DeviceRemoval): void {
  put(doc, DIRECTORY_MAPS.removals, removal.did, removal)
}

/**
 * Dids with a removal on file, unverified. Only for deciding whether a
 * connection is worth opening, never for deciding who may do anything.
 */
export function removedDidsUnverified(doc: Y.Doc): Set<string> {
  return new Set(
    valuesIn<DeviceRemoval>(doc, DIRECTORY_MAPS.removals)
      .map((removal) => removal.did)
      .filter((did) => typeof did === "string"),
  )
}

export function putRatification(doc: Y.Doc, ratification: Ratification): void {
  put(doc, DIRECTORY_MAPS.ratifications, ratification.device, ratification)
}

export function putLink(doc: Y.Doc, link: DeviceLink): void {
  put(doc, DIRECTORY_MAPS.links, link.did, link)
}

export function putPrekeyBundle(doc: Y.Doc, bundle: PrekeyBundle): void {
  put(doc, DIRECTORY_MAPS.prekeys, bundle.did, bundle)
}

export function putInvitationRevocation(doc: Y.Doc, revocation: InvitationRevocation): void {
  put(doc, DIRECTORY_MAPS.invitationRevocations, revocation.invitationId, revocation)
}

export function putInvitation(doc: Y.Doc, invitation: Invitation): void {
  put(doc, DIRECTORY_MAPS.invitations, invitation.invitationId, invitation)
}

/**
 * Each its own slot, so a second redemption of one invitation - the sign it
 * was reused - sits beside the first rather than replacing it.
 */
export function putRedemption(doc: Y.Doc, redemption: Redemption): void {
  put(doc, DIRECTORY_MAPS.redemptions, redemption.invitationId, redemption)
}

/** Every redemption, including those filed as a list per invitation before they had slots. */
export function redemptionsIn(doc: Y.Doc): Redemption[] {
  const out = new Map<string, Redemption>()
  for (const value of map<Redemption | Redemption[]>(doc, DIRECTORY_MAPS.redemptions).values()) {
    for (const redemption of Array.isArray(value) ? value : [value]) {
      if (typeof redemption?.sig === "string" && typeof redemption.invitationId === "string") {
        out.set(redemption.sig, redemption)
      }
    }
  }
  return [...out.values()]
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
  // A ratification by an admin counts, and so does one an admin kept - an owner
  // who took over keeps the ratifications the owner before them signed.
  const pending = new Set(valuesIn<Ratification>(doc, DIRECTORY_MAPS.ratifications))
  for (let grew = true; grew; ) {
    grew = false
    for (const ratification of pending) {
      const by = kept.has(ratification.sig) ? [ratification.admin] : base
      if (!(await verifyRatification(ratification, by, options))) continue
      for (const signature of ratification.kept) kept.add(signature)
      pending.delete(ratification)
      grew = true
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

  // Every valid record per device: it may have published more than one.
  const records = new Map<string, DeviceRecord[]>()
  for (const record of valuesIn<DeviceRecord>(doc, DIRECTORY_MAPS.devices)) {
    if (typeof record.did === "string" && (await verifyDeviceRecord(record))) {
      records.set(record.did, [...(records.get(record.did) ?? []), record])
    } else rejected += 1
  }
  const recordFor = (did: string, sealingDid: string) =>
    records.get(did)?.find((record) => record.sealingDid === sealingDid) ?? records.get(did)?.[0]

  // Admissions first: links can only be rooted in an admitted parent. The
  // newest valid admission of a device stands, unless a removal came after it.
  const admitted = new Map<string, AdmittedDevice>()
  const removals = bySubject(valuesIn<DeviceRemoval>(doc, DIRECTORY_MAPS.removals), (removal) => removal.did)
  const removed = new Set<string>()
  const admissions = bySubject(valuesIn<DeviceAdmission>(doc, DIRECTORY_MAPS.admissions), (admission) => admission.did)
  for (const [did, candidates] of admissions) {
    let standing: AdmittedDevice | null = null
    for (const admission of newestFirst(candidates, (each) => each.issuedAt)) {
      const record = recordFor(did, admission.sealingDid)
      const device = record ? { record, admission } : null
      if (device && (await verifyAdmittedDevice(device, trustedAdminDids, options))) {
        standing = device
        break
      }
      rejected += 1
    }
    if (!standing) continue
    // Removed is not rejected: the admission was real, and an admin ended it.
    // Leaving it out here is what stops everything built on the directory -
    // the author check, the member list - from honouring it.
    let ended = false
    for (const removal of removals.get(did) ?? []) {
      if (await verifyDeviceRemoval(removal, standing.admission, trustedAdminDids)) ended = true
    }
    if (ended) {
      removed.add(did)
      continue
    }
    admitted.set(did, standing)
  }

  const linked: LinkedDevice[] = []
  const revocations = bySubject(valuesIn<LinkRevocation>(doc, DIRECTORY_MAPS.linkRevocations), (revocation) => revocation.did)
  const admittedDevices = [...admitted.values()].map((device) => ({ kind: "admitted" as const, ...device }))
  const links = bySubject(valuesIn<DeviceLink>(doc, DIRECTORY_MAPS.links), (link) => link.did)
  for (const [did, candidates] of links) {
    if (admitted.has(did)) continue
    let standing: LinkedDevice | null = null
    for (const link of newestFirst(candidates, (each) => each.issuedAt)) {
      const parent = admitted.get(link.parent)
      for (const record of parent ? (records.get(did) ?? []) : []) {
        if (await verifyLinkedDevice({ record, link }, parent!, trustedAdminDids, options)) {
          standing = { record, link }
          break
        }
      }
      if (standing) break
      rejected += 1
    }
    if (!standing) continue
    // Unlinked by one of the member's own admitted devices - a lost phone. It
    // applies to links issued before it, so the device can be linked again.
    let unlinked = false
    for (const revocation of revocations.get(did) ?? []) {
      if (revocation.revokedAt >= standing.link.issuedAt && (await verifyLinkRevocation(revocation, standing.link, admittedDevices))) {
        unlinked = true
      }
    }
    if (unlinked) {
      removed.add(did)
      continue
    }
    linked.push(standing)
  }

  const devices: MemberDevice[] = [
    ...[...admitted.values()].map((device) => ({ kind: "admitted" as const, ...device })),
    ...linked.map((device) => ({ kind: "linked" as const, ...device })),
  ]

  const prekeys = new Map<string, PrekeyBundle>()
  const bundles = bySubject(valuesIn<PrekeyBundle>(doc, DIRECTORY_MAPS.prekeys), (bundle) => bundle.did)
  for (const [did, candidates] of bundles) {
    // Only devices that are actually present may publish a sealing target.
    const present = admitted.has(did) || linked.some((device) => device.record.did === did)
    for (const bundle of newestFirst(candidates, (each) => each.publishedAt)) {
      if (present && (await verifyPrekeyBundle(bundle, { now }))) {
        prekeys.set(did, bundle)
        break
      }
      rejected += 1
    }
  }

  const signedInvitations: Invitation[] = []
  const issued = bySubject(valuesIn<Invitation>(doc, DIRECTORY_MAPS.invitations), (invitation) => invitation.invitationId)
  for (const candidates of issued.values()) {
    for (const invitation of newestFirst(candidates, (each) => each.issuedAt)) {
      if (await verifyInvitation(invitation, trustedAdminDids, { ...options, now })) {
        signedInvitations.push(invitation)
        break
      }
      rejected += 1
    }
  }

  // A withdrawn invitation is not a rejected record - it verified, and an admin
  // took it back. It simply stops being offered.
  const revoked = await revokedInvitationIds(
    valuesIn<InvitationRevocation>(doc, DIRECTORY_MAPS.invitationRevocations),
    signedInvitations,
    trustedAdminDids,
  )
  const invitations = signedInvitations.filter(
    (invitation) => !revoked.has(invitation.invitationId),
  )

  const byId = new Map(invitations.map((invitation) => [invitation.invitationId, invitation]))
  const redemptions = new Map<string, Redemption[]>()
  for (const redemption of redemptionsIn(doc)) {
    const invitation = byId.get(redemption.invitationId)
    if (invitation && (await verifyRedemption(redemption, invitation, { now }))) {
      redemptions.set(redemption.invitationId, [...(redemptions.get(redemption.invitationId) ?? []), redemption])
    } else rejected += 1
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
