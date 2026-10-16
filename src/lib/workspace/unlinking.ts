/**
 * Taking one of a member's own devices back out - a lost phone.
 *
 * Two acts, by possibly different devices. The member unlinks it from any of
 * their admitted devices, which stops its writes being accepted as soon as the
 * news arrives. But it still holds the current key, and chain epochs derive
 * forward from that, so it would go on reading everything written from now on
 * until the key is replaced - which only the owner can do. The owner's device
 * does it as soon as it sees a device that has been taken out and can still
 * reach the current key; if the owner is the one unlinking, that is at once.
 *
 * One of the owner's own devices acted as the owner, so it may have admitted,
 * removed and cut epochs. Unlinking it keeps what the owner has seen it sign,
 * by signature, so none of that comes undone - and nothing it signs later counts.
 */

import type * as Y from "yjs"

import {
  DIRECTORY_MAPS,
  putLinkRevocation,
  putRatification,
  ratify,
  readDirectory,
  valuesIn,
} from "@/lib/directory"
import type { DeviceIdentity } from "@/lib/identity"
import { segmentStart, type KeyRecipient } from "@/lib/keys"
import { revokeLink, signEpochRecord } from "@/lib/membership"

import { signedBy } from "./kept-records"
import {
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  restoreDomainAdmin,
  storedSealedKeys,
} from "./notebook-keys"
import { readNotebookWorkspace, recoveryRecipients, workspaceIdFor } from "./notebook-workspace"

export interface UnlinkOptions {
  doc: Y.Doc
  notebookId: string
  /** One of the member's own admitted devices. A linked device cannot unlink another. */
  actor: DeviceIdentity
  /** The linked device to take out. */
  did: string
  reason?: string
  now?: number
}

export async function unlinkDevice(options: UnlinkOptions): Promise<"unlinked" | "not-linked"> {
  const workspace = await readNotebookWorkspace({
    doc: options.doc,
    notebookId: options.notebookId,
    selfDid: options.actor.did,
  })
  const owner = workspace.ownership.owner
  if (workspace.ownership.status !== "established" || !owner) {
    throw new Error("this notebook has no established owner")
  }
  const directory = await readDirectory(options.doc, [owner], { workspace: workspaceIdFor(options.notebookId) })
  const target = directory.devices.find((device) => device.record.did === options.did)
  if (target?.kind !== "linked") return "not-linked"

  const actor = directory.devices.find((device) => device.record.did === options.actor.did)
  if (actor?.kind !== "admitted" || actor.admission.member !== target.link.member) {
    throw new Error("only one of this person's own approved devices can unlink it")
  }

  const now = options.now ?? Date.now()
  const revocation = await revokeLink({
    signingKey: options.actor.signingKey,
    revoker: options.actor.did,
    link: target.link,
    revokedAt: now,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  const deputy = directory.deputies.has(target.record.did)
  const ratification = deputy
    ? await ratify({
        signingKey: options.actor.signingKey,
        admin: options.actor.did,
        workspace: workspaceIdFor(options.notebookId),
        device: target.record.did,
        kept: await signedBy(options.doc, options.notebookId, [target.record.did]),
        at: now,
      })
    : null
  // Together, so nobody ever sees the device gone and its work undone.
  options.doc.transact(() => {
    putLinkRevocation(options.doc, revocation)
    if (ratification) putRatification(options.doc, ratification)
  })
  return "unlinked"
}

export interface RotateAwayOptions {
  doc: Y.Doc
  notebookId: string
  owner: DeviceIdentity
  now?: number
}

/**
 * Replace the key if anyone taken out could still reach it. Only the owner
 * can, so anywhere else this does nothing. Returns whether it rotated.
 */
export async function rotateAway(options: RotateAwayOptions): Promise<boolean> {
  const keys = await readNotebookKeys({
    doc: options.doc,
    notebookId: options.notebookId,
    device: options.owner,
    owner: options.owner.did,
  })
  if (keys.access !== "reader" || !keys.timeline || !keys.keyring) return false

  const directory = await readDirectory(options.doc, [options.owner.did], {
    workspace: workspaceIdFor(options.notebookId),
  })
  const departed = new Set<string>()
  for (const record of valuesIn<{ did: string; sealingDid: string }>(options.doc, DIRECTORY_MAPS.devices)) {
    if (directory.removed.has(record.did)) departed.add(record.sealingDid)
  }
  // Whether anyone taken out holds a key the current one derives from. Asked
  // of the stored copies rather than of timestamps: who could reach which
  // epoch is written down, and clocks on different devices are not.
  const start = segmentStart(keys.timeline, keys.keyring.currentEpoch)
  const exposed = storedSealedKeys(options.doc, keyDomainFor(options.notebookId)).some(
    (copy) => copy.epoch >= start && departed.has(copy.recipient),
  )
  if (!exposed) return false

  const domain = await restoreDomainAdmin(keys)
  if (!domain) return false
  const remaining: KeyRecipient[] = [
    ...directory.devices.map((device) => ({ sealingDid: device.record.sealingDid })),
    ...(await recoveryRecipients(options.doc, options.notebookId)),
  ]
  const cut = await domain.rotate(remaining, {
    reason: "device-unlinked",
    ...(options.now === undefined ? {} : { createdAt: options.now }),
  })
  const signed = await signEpochRecord(cut.record, options.owner.signingKey, options.owner.did)
  options.doc.transact(() => {
    putEpochRecord(options.doc, signed)
    putSealedKeys(options.doc, cut.sealed)
  })
  return true
}

