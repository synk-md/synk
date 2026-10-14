/**
 * Adding another of a member's own devices to a notebook.
 *
 * No admin involved: the member's admitted device signs a link to the new one,
 * and the link is a leaf - it inherits the member and the notebook, and cannot
 * link further. The new device writes under the linking device's grant, so it
 * can do exactly what that device can and loses it when that device does.
 *
 * It is handed every key the linking device can read, sealed to it, so it sees
 * the same history its owner does - not a joiner's view from today onwards. It
 * checks each one against the owner's commitments like any other copy.
 */

import type * as Y from "yjs"

import { putDeviceRecord, putLink, readDirectory } from "@/lib/directory"
import { createDeviceLink, verifyDeviceRecord, type DeviceIdentity, type DeviceRecord } from "@/lib/identity"
import { sealEpochKey, type SealedEpochKey } from "@/lib/keys"

import { keyDomainFor, putSealedKeys, readNotebookKeys } from "./notebook-keys"
import { readNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"

export interface LinkIntoNotebookOptions {
  doc: Y.Doc
  notebookId: string
  /** This device. Must be admitted here - a linked device cannot link another. */
  parent: DeviceIdentity
  /** The new device's own signed record, carrying its keys. */
  record: DeviceRecord
  now?: number
}

export type LinkOutcome = "linked" | "already-present"

export async function linkIntoNotebook(options: LinkIntoNotebookOptions): Promise<LinkOutcome> {
  const now = options.now ?? Date.now()
  if (!(await verifyDeviceRecord(options.record))) {
    throw new Error("the new device's record does not verify")
  }

  const workspace = await readNotebookWorkspace({
    doc: options.doc,
    notebookId: options.notebookId,
    selfDid: options.parent.did,
    now,
  })
  const owner = workspace.ownership.owner
  if (workspace.ownership.status !== "established" || !owner) {
    throw new Error("this notebook has no established owner to link under")
  }
  const directory = await readDirectory(options.doc, [owner], { workspace: workspaceIdFor(options.notebookId) })
  if (directory.devices.some((device) => device.record.did === options.record.did)) return "already-present"

  const parent = directory.devices.find((device) => device.record.did === options.parent.did)
  if (!parent) throw new Error("this device is not a member of the notebook")
  if (parent.kind !== "admitted") throw new Error("only a device admitted by the owner can link another")

  const link = await createDeviceLink({
    parentSigningKey: options.parent.signingKey,
    parentAdmission: parent.admission,
    record: options.record,
    issuedAt: now,
  })

  // Every epoch this device can open, so the new one reads what its owner reads.
  const keys = await readNotebookKeys({
    doc: options.doc,
    notebookId: options.notebookId,
    device: options.parent,
    owner,
    now,
  })
  if (keys.access !== "reader" || !keys.keyring) {
    throw new Error("this device cannot open the notebook's keys, so it has none to pass on")
  }
  const domain = keyDomainFor(options.notebookId)
  const sealed: SealedEpochKey[] = []
  for (const epoch of keys.keyring.readableEpochs()) {
    const key = await keys.keyring.keyFor(epoch)
    if (key) sealed.push(await sealEpochKey(domain, epoch, options.record.sealingDid, key))
  }

  options.doc.transact(() => {
    putDeviceRecord(options.doc, options.record)
    putLink(options.doc, link)
    putSealedKeys(options.doc, sealed)
  })
  return "linked"
}
