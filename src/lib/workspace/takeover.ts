/**
 * Taking over a notebook whose owner's device is lost.
 *
 * Either a device the owner named ahead of time takes over, or the recovery
 * code makes any device the owner - one that may hold nothing yet, which then
 * opens every key through the copies sealed to the code.
 *
 * Taking over is what unlinking a deputy is, for the owner: the new owner
 * keeps everything the old owner and their devices signed that it has seen,
 * so nobody they let in falls out and nobody they removed comes back; then
 * takes the old device out and cuts a key it cannot reach. Anything the lost
 * device signs afterwards is not kept, however it is dated.
 */

import type * as Y from "yjs"

import {
  putAdmission,
  putDeviceRecord,
  putRatification,
  putRemoval,
  ratify,
  readDirectory,
  removeDevice,
} from "@/lib/directory"
import { createDeviceAdmission, type DeviceIdentity } from "@/lib/identity"
import { sealEpochKey, type KeyRecipient } from "@/lib/keys"
import { signEpochRecord } from "@/lib/membership"

import { issueOwnerRoot, putCapability } from "./capabilities"
import { signedBy } from "./kept-records"
import {
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  restoreDomainAdmin,
} from "./notebook-keys"
import {
  readNotebookWorkspace,
  recoveryRecipients,
  resourceIdFor,
  workspaceIdFor,
} from "./notebook-workspace"
import { generateRecoveryCode, recoveryIdentity, recoveryKeyOf, type RecoveryCode } from "./recovery-code"
import { nameStandby, putStandby, putSuccession, signSuccession, standbysIn, type Succession } from "./succession"

export interface TakeoverOptions {
  doc: Y.Doc
  notebookId: string
  /** The device becoming the owner. */
  device: DeviceIdentity
  /**
   * Run once this device owns the notebook and before the lost one is taken
   * out: while its writing is still accepted, so it can be gathered up and
   * kept in snapshots this device signs.
   */
  beforeRemoval?: () => Promise<void>
  now?: number
}

/** The owner names one of their own devices as able to take over. */
export async function nameStandbyDevice(options: {
  doc: Y.Doc
  notebookId: string
  owner: DeviceIdentity
  device: string
  now?: number
}): Promise<void> {
  const workspace = await readNotebookWorkspace({ doc: options.doc, notebookId: options.notebookId })
  if (workspace.ownership.owner !== options.owner.did) throw new Error("Only the owner can name who may take over.")
  putStandby(
    options.doc,
    await nameStandby({
      signingKey: options.owner.signingKey,
      owner: options.owner.did,
      workspace: workspaceIdFor(options.notebookId),
      device: options.device,
      ...(options.now === undefined ? {} : { at: options.now }),
    }),
  )
}

/** Whether a device has been named able to take over from the owner now. Unverified: for what to offer. */
export function isStandby(doc: Y.Doc, owner: string, device: string): boolean {
  return standbysIn(doc).some((standby) => standby.owner === owner && standby.device === device)
}

/** A device the owner named takes over. */
export async function takeOverAsStandby(options: TakeoverOptions): Promise<void> {
  const workspace = await readNotebookWorkspace({ doc: options.doc, notebookId: options.notebookId })
  const from = workspace.ownership.owner
  if (!from || from === options.device.did) throw new Error("There is no owner here to take over from.")
  if (!isStandby(options.doc, from, options.device.did)) {
    throw new Error("The owner has not named this device as able to take over.")
  }
  const succession = await signSuccession({
    signingKey: options.device.signingKey,
    workspace: workspace.workspace,
    from,
    to: options.device.did,
    by: "standby",
    signer: options.device.did,
    ...(options.now === undefined ? {} : { at: options.now }),
  })
  await complete({ ...options, from, succession })
}

/**
 * The recovery code makes this device the owner. Returns the next code, which
 * replaces the one just used and has to be shown, once, now.
 */
export async function recoverWithCode(options: TakeoverOptions & { code: RecoveryCode }): Promise<RecoveryCode> {
  const workspace = await readNotebookWorkspace({ doc: options.doc, notebookId: options.notebookId })
  const from = workspace.ownership.owner
  const recovery = workspace.ownership.lineage?.recovery
  const key = await recoveryIdentity(options.code.secret)
  if (!from) throw new Error("This notebook's ownership is not settled here yet.")
  if (!recovery || recovery.did !== key.did) throw new Error("That is not this notebook's recovery code.")

  // Every key the code can reach, sealed to this device too, before anything
  // else - so this device can open the notebook as itself from here on.
  const keys = await readNotebookKeys({ doc: options.doc, notebookId: options.notebookId, device: key, owner: from })
  if (!keys.keyring) throw new Error("The recovery code opens none of this notebook's keys.")
  const domain = keyDomainFor(options.notebookId)
  const sealed = []
  for (const epoch of keys.keyring.readableEpochs()) {
    const value = await keys.keyring.keyFor(epoch)
    if (value) sealed.push(await sealEpochKey(domain, epoch, options.device.record.sealingDid, value))
  }
  putSealedKeys(options.doc, sealed)

  const next = generateRecoveryCode(options.notebookId)
  const succession = await signSuccession({
    signingKey: key.signingKey,
    workspace: workspace.workspace,
    from,
    to: options.device.did,
    by: "recovery",
    signer: key.did,
    nextRecovery: await recoveryKeyOf(next.secret),
    ...(options.now === undefined ? {} : { at: options.now }),
  })
  await complete({ ...options, from, succession })
  return next
}

async function complete(options: TakeoverOptions & { from: string; succession: Succession }): Promise<void> {
  const { doc, notebookId, device, from } = options
  const workspaceId = workspaceIdFor(notebookId)
  const now = options.now ?? Date.now()

  // What the old owner, and every device acting as them, signed.
  const before = await readDirectory(doc, [from], { workspace: workspaceId })
  const deputies = [...before.deputies].filter(([, principal]) => principal === from).map(([did]) => did)
  const leaving = before.devices.find((entry) => entry.record.did === from)
  const kept = await signedBy(doc, notebookId, [from, ...deputies])

  // The new owner stands as the same person, admitted by themselves.
  const self = leaving?.kind === "admitted" ? leaving.admission : null
  const admission = await createDeviceAdmission({
    adminSigningKey: device.signingKey,
    adminDid: device.did,
    record: device.record,
    member: self?.member ?? `member:${device.did.slice(-16)}`,
    label: self?.label ?? "Owner",
    workspace: workspaceId,
    issuedAt: now,
  })
  const ratification = await ratify({ signingKey: device.signingKey, admin: device.did, workspace: workspaceId, device: from, kept, at: now })
  const root = await issueOwnerRoot({ signingKey: device.signingKey, owner: device.did, resource: resourceIdFor(notebookId), now })
  doc.transact(() => {
    putSuccession(doc, options.succession)
    putRatification(doc, ratification)
    putDeviceRecord(doc, device.record)
    putAdmission(doc, admission)
    putCapability(doc, root)
  })

  await options.beforeRemoval?.()

  // The lost device out, and its other devices with it: they stood on it.
  if (self) putRemoval(doc, await removeDevice({ signingKey: device.signingKey, admin: device.did, admission: self, removedAt: now }))

  // A key the lost device cannot reach, for everyone still here and the code.
  const keys = await readNotebookKeys({ doc, notebookId, device, owner: device.did, now })
  const domainAdmin = await restoreDomainAdmin(keys)
  if (!domainAdmin) throw new Error("This device cannot open the notebook's current key, so it cannot replace it.")
  const after = await readDirectory(doc, [device.did], { workspace: workspaceId })
  const recipients: KeyRecipient[] = [
    ...after.devices.map((entry) => ({ sealingDid: entry.record.sealingDid })),
    ...(await recoveryRecipients(doc, notebookId)),
  ]
  const cut = await domainAdmin.rotate(recipients, { reason: "owner-succeeded", createdAt: now })
  const signed = await signEpochRecord(cut.record, device.signingKey, device.did)
  doc.transact(() => {
    putEpochRecord(doc, signed)
    putSealedKeys(doc, cut.sealed)
  })
}
