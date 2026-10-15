/**
 * Taking a member out of a notebook: withdraw, revoke, rotate, reseal.
 *
 * Each half fails differently, and both are needed. The removal record and the
 * revoked grants stop the member's writes being accepted, but only on devices
 * that have heard about them. The rotation denies reads at once, wherever the
 * news has or has not reached: nothing sealed from here on is sealed to them.
 *
 * Everything is written in one transaction, so no peer ever sees the new epoch
 * without the keys for the people who remain, or the withdrawal without the
 * rotation behind it.
 */

import type * as Y from "yjs"

import { revokeCapability, type Revocation } from "@/lib/authz"
import { putRemoval, removeDevice, type DeviceRemoval } from "@/lib/directory"
import type { DeviceIdentity, MemberDevice } from "@/lib/identity"
import type { KeyRecipient } from "@/lib/keys"
import { assertKeyringCurrent, signEpochRecord } from "@/lib/membership"

import { putRevocation, readCapabilities } from "./capabilities"
import { putEpochRecord, putSealedKeys, readNotebookKeys, restoreDomainAdmin } from "./notebook-keys"
import { readNotebookWorkspace } from "./notebook-workspace"

export interface RemoveFromNotebookOptions {
  doc: Y.Doc
  notebookId: string
  /** The device removing: the owner, or one of the owner's own linked devices. */
  owner: DeviceIdentity
  /** The notebook's owner, when `owner` is one of their linked devices. */
  ownerDid?: string
  /** Every device admitted under this member id goes. Leaving one would leave them access. */
  member: string
  reason?: string
  now?: number
}

export interface MemberRemoved {
  member: string
  devices: string[]
  /** The epoch nothing is sealed to them under. */
  epoch: number
  /** Who the new key was sealed to. */
  remaining: string[]
}

function memberOf(device: MemberDevice): string {
  return device.kind === "admitted" ? device.admission.member : device.link.member
}

export async function removeFromNotebook(options: RemoveFromNotebookOptions): Promise<MemberRemoved> {
  const now = options.now ?? Date.now()
  const ownerDid = options.ownerDid ?? options.owner.did
  const admin = options.owner

  const workspace = await readNotebookWorkspace({
    doc: options.doc,
    notebookId: options.notebookId,
    selfDid: admin.did,
    expectedOwner: ownerDid,
    now,
  })
  if (
    workspace.ownership.status !== "established" ||
    workspace.ownership.owner !== ownerDid ||
    !workspace.directory?.admins.includes(admin.did)
  ) {
    throw new Error("only the notebook's owner can remove members")
  }
  const devices = workspace.directory?.devices ?? []

  const leaving = devices.filter((device) => memberOf(device) === options.member)
  if (leaving.length === 0) throw new Error("nobody by that id is a member of this notebook")
  if (leaving.some((device) => device.record.did === ownerDid)) {
    throw new Error("the owner cannot remove themselves")
  }
  const leavingDids = new Set(leaving.map((device) => device.record.did))
  const remaining = devices.filter((device) => !leavingDids.has(device.record.did))

  const keys = await readNotebookKeys({
    doc: options.doc,
    notebookId: options.notebookId,
    device: admin,
    owner: ownerDid,
    now,
  })
  const domain = await restoreDomainAdmin(keys)
  if (!domain || !keys.keyring) {
    throw new Error("cannot remove: this device cannot open the notebook's current key")
  }
  // Sealing from a stale view would leave out whoever joined since.
  assertKeyringCurrent(keys.keyring, domain.timeline)

  const recipients: KeyRecipient[] = remaining.map((device) => ({
    sealingDid: device.record.sealingDid,
  }))
  const cut = await domain.removeMember(recipients, { createdAt: now })
  const signedEpoch = await signEpochRecord(cut.record, admin.signingKey, admin.did)

  const revocations: Revocation[] = []
  for (const capability of await readCapabilities(options.doc)) {
    if (!leavingDids.has(capability.payload.aud)) continue
    revocations.push(
      await revokeCapability({
        signingKey: admin.signingKey,
        issuer: admin.did,
        capabilityCid: capability.cid,
        revokedAt: now,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    )
  }

  // Linked devices need no record of their own: they stand on an admitted
  // parent, and fall away with it.
  const removals: DeviceRemoval[] = []
  for (const device of leaving) {
    if (device.kind !== "admitted") continue
    removals.push(
      await removeDevice({
        signingKey: admin.signingKey,
        admin: admin.did,
        admission: device.admission,
        removedAt: now,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    )
  }

  options.doc.transact(() => {
    for (const removal of removals) putRemoval(options.doc, removal)
    for (const revocation of revocations) putRevocation(options.doc, revocation)
    putEpochRecord(options.doc, signedEpoch)
    putSealedKeys(options.doc, cut.sealed)
  })

  return {
    member: options.member,
    devices: [...leavingDids],
    epoch: cut.record.epoch,
    remaining: remaining.map((device) => device.record.did),
  }
}
