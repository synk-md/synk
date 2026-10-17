/**
 * Linking a new device into every notebook at once, and the new device
 * collecting them - each side doing its part through the relay, so neither
 * needs the other online when it acts.
 *
 * Imported by path, not through the workspace barrel: it reaches IndexedDB.
 */

import * as Y from "yjs"

import { collectLeaves, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import type { Bytes } from "@/lib/crypto"
import type { DeviceIdentity, DeviceRecord } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import type { SyncEngine, Transport } from "@/lib/sync"
import { createSnapshot } from "@/lib/snapshots"
import { createNotebookIndexDoc, getOrCreateYDoc, readNotebookIndexTree, unsentFlag } from "@/lib/yjs-utils"

import {
  announcementSlot,
  hasAnnouncement,
  inboxChannel,
  openAnnouncements,
  putAnnouncement,
  signAnnouncement,
  type Announcement,
} from "./announcements"
import { coverNotes } from "./cover-notes"
import { linkIntoNotebook } from "./linking"
import { rotateAway, unlinkDevice } from "./unlinking"
import { keyDomainFor, readNotebookKeys } from "./notebook-keys"
import { hasNoOperations } from "./note-snapshots"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"
import { readNotebookWorkspace } from "./notebook-workspace"
import { claimOwnershipAtRelay, liveKeys, relayConnection, relayWatch } from "./note-relay"
import { ownDevicesIn } from "./own-devices"
import { pinOwner } from "./owner-pins"
import type { RecoveryCode } from "./recovery-code"
import {
  acceptOwnership,
  isOfferedOwnership,
  isStandby,
  nameStandbyDevice,
  recoverWithCode,
  takeOverAsStandby,
} from "./takeover"
import { pairingChannel, type PairedNotebook } from "./pairing"
import {
  createDirectoryReplica,
  createTreeReplica,
  directoryChannel,
  directoryWriters,
  treeResourceId,
} from "./replicas"
import { storedWatermark } from "./stored-watermark"
import { openSyncSession, type DeliveryWatermark, type UnsentFlag } from "./sync-session"

interface Once {
  engine: SyncEngine
  doc: Y.Doc
  transport: Transport
  resourceId: string
  readableEpochs?: () => number[]
  watermark?: DeliveryWatermark
  unsent?: UnsentFlag
  /** Run until this holds, or until the time runs out. */
  done?: () => boolean | Promise<boolean>
  timeoutMs?: number
}

/** One session on a document: catch up, publish what is missing, wait if asked, go. */
async function once(options: Once): Promise<boolean> {
  let live = false
  let wake: (() => void) | undefined
  const nudge = () => wake?.()
  const session = openSyncSession({
    engine: options.engine,
    doc: options.doc,
    transport: options.transport,
    resourceId: options.resourceId,
    readableEpochs: options.readableEpochs ?? (() => []),
    relay: relayWatch,
    canAuthor: true,
    recover: "publish-state",
    ...(options.watermark ? { watermark: options.watermark } : {}),
    ...(options.unsent ? { unsent: options.unsent } : {}),
    onStatus: (status) => {
      live = status === "live"
      nudge()
    },
  })
  options.doc.on("update", nudge)
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  try {
    while (Date.now() < deadline) {
      if (live && (!options.done || (await options.done()))) {
        await options.engine.flush()
        return true
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 250)
      })
    }
    return false
  } finally {
    options.doc.off("update", nudge)
    session.close()
    options.engine.close()
  }
}

function connection() {
  const shared = relayConnection()
  if (!shared) throw new Error("Linking devices needs sync switched on.")
  return shared
}

async function ownerOf(notebookId: string, device: DeviceIdentity): Promise<string | null> {
  const handle = createNotebookIndexDoc(notebookId)
  const workspace = await readNotebookWorkspace({ doc: handle.doc, notebookId, selfDid: device.did })
  return workspace.ownership.status === "established" ? workspace.ownership.owner : null
}

async function readableKeys(notebookId: string, device: DeviceIdentity, owner: string) {
  const keys = await readNotebookKeys({ doc: createNotebookIndexDoc(notebookId).doc, notebookId, device, owner })
  return keys.access === "reader" && keys.current ? keys.keyring : null
}

async function syncDirectory(notebookId: string, device: DeviceIdentity, done?: () => Promise<boolean>) {
  const handle = createNotebookIndexDoc(notebookId)
  await handle.idb.whenSynced
  const channel = await directoryChannel(notebookId)
  const transport = connection().transportFor(channel.resourceId)
  return once({
    engine: createDirectoryReplica({
      doc: handle.doc,
      channel,
      device,
      transport,
      policy: directoryWriters(handle.doc, notebookId),
    }),
    doc: handle.doc,
    transport,
    resourceId: channel.resourceId,
    watermark: storedWatermark(handle.storage.directory),
    unsent: unsentFlag(notebookId, "directory"),
    ...(done ? { done } : {}),
  })
}

async function syncTree(
  notebookId: string,
  device: DeviceIdentity,
  owner: string,
  keyring: ReadKeySource,
  done?: () => boolean,
) {
  const handle = createNotebookIndexDoc(notebookId)
  const resourceId = treeResourceId(notebookId)
  const transport = connection().transportFor(resourceId)
  return once({
    engine: createTreeReplica({
      tree: handle.tree,
      directory: handle.doc,
      notebookId,
      owner,
      device,
      keys: liveKeys(() => keyring),
      transport,
    }),
    doc: handle.tree,
    transport,
    resourceId,
    readableEpochs: () => keyring.readableEpochs(),
    watermark: storedWatermark(handle.storage.tree),
    unsent: unsentFlag(notebookId, "tree"),
    ...(done ? { done } : {}),
  })
}

export interface PairingChannelHandle {
  doc: Y.Doc
  close(): void
}

/** The pairing's meeting place, held open while one side waits for the other. */
export async function openPairing(secret: Bytes, device: DeviceIdentity): Promise<PairingChannelHandle> {
  const channel = await pairingChannel(secret)
  const transport = connection().transportFor(channel.resourceId)
  const doc = new Y.Doc()
  const engine = createDirectoryReplica({ doc, channel, device, transport })
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId: channel.resourceId,
    readableEpochs: () => [],
    relay: relayWatch,
    canAuthor: true,
    recover: "publish-state",
  })
  return {
    doc,
    close: () => {
      session.close()
      engine.close()
    },
  }
}

export interface LinkEverywhereOptions {
  device: DeviceIdentity
  record: DeviceRecord
  notebooks: readonly PairedNotebook[]
  onProgress?: (done: number, total: number, current: PairedNotebook) => void
}

/** Link a device into one notebook and put everything it needs at the relay. Returns the owner. */
async function linkAndPublish(notebookId: string, device: DeviceIdentity, record: DeviceRecord): Promise<string> {
  const handle = createNotebookIndexDoc(notebookId)
  await handle.idb.whenSynced
  await linkIntoNotebook({ doc: handle.doc, notebookId, parent: device, record })
  const owner = await ownerOf(notebookId, device)
  const keyring = owner ? await readableKeys(notebookId, device, owner) : null
  if (!owner || !keyring) throw new Error("this device cannot open the notebook's keys")

  if (!(await syncDirectory(notebookId, device))) throw new Error("could not reach the relay")
  await syncTree(notebookId, device, owner, keyring)
  await coverNotes({ notebookId, device, owner, recipient: record.did, epoch: keyring.currentEpoch })
  // As the owner, the new device's anchors now count at the relay too.
  await claimOwnershipAtRelay({ doc: handle.doc, notebookId, device })
  return owner
}

/**
 * Link the new device into each notebook, then put everything it needs at the
 * relay: the directory with its link and keys, the tree, and a baseline of
 * every note. A notebook only ever used on this device has never been
 * published at all, and the new device has nowhere else to get it from.
 */
export async function linkEverywhere(options: LinkEverywhereOptions) {
  const linked: PairedNotebook[] = []
  const skipped: (PairedNotebook & { reason: string })[] = []
  let done = 0
  for (const notebook of options.notebooks) {
    options.onProgress?.(done, options.notebooks.length, notebook)
    try {
      const owner = await linkAndPublish(notebook.id, options.device, options.record)
      linked.push({ ...notebook, owner })
    } catch (error) {
      skipped.push({ ...notebook, reason: error instanceof Error ? error.message : "could not be linked" })
    }
    done += 1
  }
  return { linked, skipped }
}

/**
 * Take a device back out of every notebook it was linked into, and publish
 * that. Where this device is the owner the key is replaced at once; elsewhere
 * the owner's device does it the next time it opens the notebook.
 */
export async function unlinkEverywhere(options: {
  device: DeviceIdentity
  did: string
  notebooks: readonly PairedNotebook[]
}) {
  const unlinked: PairedNotebook[] = []
  const rotated: PairedNotebook[] = []
  const failed: (PairedNotebook & { reason: string })[] = []
  for (const notebook of options.notebooks) {
    try {
      const handle = createNotebookIndexDoc(notebook.id)
      await handle.idb.whenSynced
      const outcome = await unlinkDevice({ doc: handle.doc, notebookId: notebook.id, actor: options.device, did: options.did })
      if (outcome === "not-linked") continue
      unlinked.push(notebook)
      if (await rotateAway({ doc: handle.doc, notebookId: notebook.id, owner: options.device })) rotated.push(notebook)
      if (relayConnection()) await syncDirectory(notebook.id, options.device)
      // And its anchors stop counting there.
      await claimOwnershipAtRelay({ doc: handle.doc, notebookId: notebook.id, device: options.device })
    } catch (error) {
      failed.push({ ...notebook, reason: error instanceof Error ? error.message : "could not be unlinked" })
    }
  }
  return { unlinked, rotated, failed }
}

/**
 * The new device's side: the notebook's directory until this device holds its
 * keys, then the tree until there is one to show. Null when it does not arrive.
 */
export async function fetchNotebook(
  notebookId: string,
  device: DeviceIdentity,
  /** Named by the linking device; remembered before anything is read. */
  owner?: string,
): Promise<TreeNode | null> {
  if (owner) pinOwner(notebookId, owner)
  const handle = createNotebookIndexDoc(notebookId)
  await handle.idb.whenSynced
  let established: string | null = null
  let keyring: ReadKeySource | null = null
  const linked = await syncDirectory(notebookId, device, async () => {
    established ??= await ownerOf(notebookId, device)
    keyring = established ? await readableKeys(notebookId, device, established) : null
    return keyring !== null
  })
  if (!linked || !established || !keyring) return null
  const arrived = () => readNotebookIndexTree(handle).root !== undefined
  await syncTree(notebookId, device, established, keyring, arrived)
  return readNotebookIndexTree(handle).root ?? null
}

/**
 * Name one of this owner's devices as able to take over, in every notebook
 * this device owns. Returns the notebooks it was named in.
 */
export async function nameStandbyEverywhere(options: {
  device: DeviceIdentity
  standby: string
  notebooks: readonly PairedNotebook[]
  /** Offer ownership now, not only if this device is lost. */
  handover?: boolean
}): Promise<PairedNotebook[]> {
  const named: PairedNotebook[] = []
  for (const notebook of options.notebooks) {
    const handle = createNotebookIndexDoc(notebook.id)
    await handle.idb.whenSynced
    if ((await ownerOf(notebook.id, options.device)) !== options.device.did) continue
    await nameStandbyDevice({
      doc: handle.doc,
      notebookId: notebook.id,
      owner: options.device,
      device: options.standby,
      ...(options.handover ? { handover: true } : {}),
    })
    named.push(notebook)
    if (relayConnection()) await syncDirectory(notebook.id, options.device)
  }
  return named
}

/** Take over every notebook whose owner named this device. Returns those taken over, and why any failed. */
export async function takeOverEverywhere(options: { device: DeviceIdentity; notebooks: readonly PairedNotebook[] }) {
  const taken: PairedNotebook[] = []
  const failed: (PairedNotebook & { reason: string })[] = []
  for (const notebook of options.notebooks) {
    try {
      const handle = createNotebookIndexDoc(notebook.id)
      await handle.idb.whenSynced
      if (relayConnection()) await syncDirectory(notebook.id, options.device)
      const owner = await ownerOf(notebook.id, options.device)
      if (!owner || owner === options.device.did || !isStandby(handle.doc, owner, options.device.did)) continue
      await takeOverAsStandby({
        doc: handle.doc,
        notebookId: notebook.id,
        device: options.device,
        ...(relayConnection() ? { beforeRemoval: () => anchorEveryNote(notebook.id, options.device) } : {}),
      })
      taken.push(notebook)
      if (relayConnection()) {
        await syncDirectory(notebook.id, options.device)
        await claimOwnershipAtRelay({ doc: handle.doc, notebookId: notebook.id, device: options.device })
      }
    } catch (error) {
      failed.push({ ...notebook, reason: error instanceof Error ? error.message : "could not be taken over" })
    }
  }
  return { taken, failed }
}

/**
 * Recover a notebook onto this device from its code, with nothing of it here
 * yet: its directory from the relay, ownership through the code, every key
 * through the copies sealed to it, then its tree. Returns the tree, and the
 * code that replaces the one used.
 */
export async function recoverNotebook(options: { code: RecoveryCode; device: DeviceIdentity }) {
  const { notebookId } = options.code
  const handle = createNotebookIndexDoc(notebookId)
  await handle.idb.whenSynced
  const arrived = await syncDirectory(notebookId, options.device, async () => (await ownerOf(notebookId, options.device)) !== null)
  if (!arrived) throw new Error("That notebook could not be found on the relay. Check the code, and that sync is on.")

  const next = await recoverWithCode({
    doc: handle.doc,
    notebookId,
    device: options.device,
    code: options.code,
    // The tree first, so there is a list of notes to gather.
    beforeRemoval: async () => {
      const owner = await ownerOf(notebookId, options.device)
      const keyring = owner ? await readableKeys(notebookId, options.device, owner) : null
      if (owner && keyring) {
        await syncTree(notebookId, options.device, owner, keyring, () => readNotebookIndexTree(handle).root !== undefined)
      }
      await anchorEveryNote(notebookId, options.device)
    },
  })
  if (!(await syncDirectory(notebookId, options.device))) throw new Error("Recovered, but could not reach the relay to say so.")
  await claimOwnershipAtRelay({ doc: handle.doc, notebookId, device: options.device })

  const keyring = await readableKeys(notebookId, options.device, options.device.did)
  if (!keyring) throw new Error("Recovered, but this device cannot open the notebook's keys.")
  const arrivedTree = () => readNotebookIndexTree(handle).root !== undefined
  await syncTree(notebookId, options.device, options.device.did, keyring, arrivedTree)
  return { root: readNotebookIndexTree(handle).root ?? null, next }
}

/**
 * Every note, gathered from the relay and kept in a snapshot this device
 * signs. Run while the old owner is still a member: once it is taken out,
 * everything it wrote is refused by any device that did not already hold it,
 * and these are what new devices start from instead.
 */
async function anchorEveryNote(notebookId: string, device: DeviceIdentity): Promise<void> {
  const handle = createNotebookIndexDoc(notebookId)
  // Still the old owner's notebook: gathered before anything changes hands.
  const owner = await ownerOf(notebookId, device)
  if (!owner) throw new Error("This notebook's ownership is not settled here.")
  const keyring = await readableKeys(notebookId, device, owner)
  if (!keyring) throw new Error("This device cannot open the notebook's keys, so it cannot keep its notes.")
  const shared = connection()
  for (const noteId of collectLeaves(readNotebookIndexTree(handle).root).noteIds) {
    const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
    await idb.whenSynced
    const resourceId = noteResourceId(notebookId, noteId)
    const transport = shared.transportFor(resourceId)
    const engine = createNoteSyncEngine({
      doc,
      notebookId,
      noteId,
      index: handle.doc,
      owner,
      author: device.did,
      signingKey: device.signingKey,
      clientId: device.clientId,
      keys: liveKeys(() => keyring),
      transport,
    })
    // Only gathering: nothing of this device's own goes out from here.
    let caughtUp: () => void = () => undefined
    const live = new Promise<void>((resolve) => {
      caughtUp = resolve
      setTimeout(resolve, 20_000)
    })
    const session = openSyncSession({
      engine,
      doc,
      transport,
      resourceId,
      readableEpochs: () => keyring.readableEpochs(),
      relay: relayWatch,
      baseline: { applied: () => null, record: () => undefined },
      canAuthor: false,
      onStatus: (status) => {
        if (status === "live") caughtUp()
      },
    })
    try {
      await live
      await session.settled()
      if (hasNoOperations(doc)) continue
      const epoch = keyring.currentEpoch
      const dek = await keyring.keyFor(epoch)
      if (!dek) continue
      await transport.depositSnapshot(
        await createSnapshot({
          signingKey: device.signingKey,
          author: device.did,
          domain: keyDomainFor(notebookId),
          resourceId,
          kind: "automatic",
          epoch,
          dek,
          state: Y.encodeStateAsUpdate(doc),
          covers: engine.deliveryVector(),
        }),
      )
    } finally {
      session.close()
      engine.close()
    }
  }
}

/** Accept ownership of every notebook whose owner offered it to this device. Their device stays in. */
export async function acceptOwnershipEverywhere(options: { device: DeviceIdentity; notebooks: readonly PairedNotebook[] }) {
  const accepted: PairedNotebook[] = []
  const failed: (PairedNotebook & { reason: string })[] = []
  for (const notebook of options.notebooks) {
    try {
      const handle = createNotebookIndexDoc(notebook.id)
      await handle.idb.whenSynced
      if (relayConnection()) await syncDirectory(notebook.id, options.device)
      const owner = await ownerOf(notebook.id, options.device)
      if (!owner || owner === options.device.did || !isOfferedOwnership(handle.doc, owner, options.device.did)) continue
      await acceptOwnership({ doc: handle.doc, notebookId: notebook.id, device: options.device })
      accepted.push(notebook)
      if (relayConnection()) {
        await syncDirectory(notebook.id, options.device)
        await claimOwnershipAtRelay({ doc: handle.doc, notebookId: notebook.id, device: options.device })
      }
    } catch (error) {
      failed.push({ ...notebook, reason: error instanceof Error ? error.message : "could not be accepted" })
    }
  }
  return { accepted, failed }
}

/** This device's own other devices, across the notebooks it holds. */
export async function ownDevices(device: DeviceIdentity, notebookIds: readonly string[]): Promise<Map<string, DeviceRecord>> {
  const notebooks = []
  for (const notebookId of notebookIds) {
    const handle = createNotebookIndexDoc(notebookId)
    await handle.idb.whenSynced
    notebooks.push({ doc: handle.doc, notebookId })
  }
  return ownDevicesIn(device, notebooks)
}

/** Post what a device has been linked into to its inbox, where not already there. Returns how many were added. */
async function announceTo(
  device: DeviceIdentity,
  record: DeviceRecord,
  notebooks: readonly (PairedNotebook & { owner: string })[],
): Promise<number> {
  const channel = await inboxChannel(record.sealingDid)
  const transport = connection().transportFor(channel.resourceId)
  const doc = new Y.Doc()
  let added = 0
  let filed = false
  try {
    await once({
      engine: createDirectoryReplica({ doc, channel, device, transport }),
      doc,
      transport,
      resourceId: channel.resourceId,
      // Once caught up, so a slot already there is seen and left alone.
      done: async () => {
        if (filed) return true
        filed = true
        for (const notebook of notebooks) {
          const slot = await announcementSlot(device.signingKey, notebook.id, record.did)
          if (hasAnnouncement(doc, slot)) continue
          const announcement = await signAnnouncement(device.signingKey, {
            notebookId: notebook.id,
            name: notebook.name,
            owner: notebook.owner,
            by: device.did,
            to: record.did,
          })
          await putAnnouncement(doc, slot, record.sealingDid, announcement)
          added += 1
        }
        return true
      },
    })
  } finally {
    doc.destroy()
  }
  return added
}

export interface FollowResult {
  linked: { notebookId: string; did: string }[]
  failed: { notebookId: string; did: string; reason: string }[]
  announced: number
}

let following: Promise<unknown> = Promise.resolve()

/**
 * Bring this person's other devices into every notebook this device is in on
 * its own approval - one created or joined since they were linked - and tell
 * each where to find them. A notebook this device is only linked into is the
 * device that linked it's to share.
 */
export function followEverywhere(options: { device: DeviceIdentity; notebooks: readonly PairedNotebook[] }): Promise<FollowResult> {
  const run = following.then(async () => {
    const result: FollowResult = { linked: [], failed: [], announced: 0 }
    if (!relayConnection()) return result
    const own = await ownDevices(options.device, options.notebooks.map((notebook) => notebook.id))
    if (own.size === 0) return result

    const toAnnounce = new Map<string, (PairedNotebook & { owner: string })[]>()
    for (const notebook of options.notebooks) {
      const handle = createNotebookIndexDoc(notebook.id)
      await handle.idb.whenSynced
      const workspace = await readNotebookWorkspace({ doc: handle.doc, notebookId: notebook.id, selfDid: options.device.did })
      const owner = workspace.ownership.owner
      if (workspace.self?.kind !== "admitted" || !owner) continue
      const present = new Set(workspace.directory?.devices.map((entry) => entry.record.did))
      for (const [did, record] of own) {
        if (!present.has(did)) {
          try {
            await linkAndPublish(notebook.id, options.device, record)
            result.linked.push({ notebookId: notebook.id, did })
          } catch (error) {
            result.failed.push({ notebookId: notebook.id, did, reason: error instanceof Error ? error.message : "could not be linked" })
            continue
          }
        }
        toAnnounce.set(did, [...(toAnnounce.get(did) ?? []), { ...notebook, owner }])
      }
    }

    for (const [did, notebooks] of toAnnounce) {
      const record = own.get(did)
      if (record) result.announced += await announceTo(options.device, record, notebooks)
    }
    return result
  })
  following = run.catch(() => undefined)
  return run
}

export interface InboxWatch {
  /** Read the inbox again, for a retry. */
  check(): void
  close(): void
}

/**
 * This device's inbox, held open. Calls back with every announcement from one
 * of its own devices, and again whenever the inbox changes.
 */
export function watchInbox(options: {
  device: DeviceIdentity
  notebookIds: () => readonly string[]
  onAnnouncements: (announcements: Announcement[]) => void | Promise<void>
}): InboxWatch {
  const doc = new Y.Doc()
  let closed = false
  let close = () => {}
  let running = false
  let again = false

  const check = () => {
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    void (async () => {
      try {
        do {
          again = false
          if (!hasAnnouncement(doc)) continue
          const own = await ownDevices(options.device, options.notebookIds())
          const believed = await openAnnouncements(doc, options.device.sealingKey, options.device.did, (sender) => own.has(sender))
          if (believed.length > 0 && !closed) await options.onAnnouncements(believed)
        } while (again && !closed)
      } catch (error) {
        console.warn("Could not read this device's inbox", error)
      } finally {
        running = false
      }
    })()
  }

  void (async () => {
    const shared = relayConnection()
    if (!shared) return
    const channel = await inboxChannel(options.device.record.sealingDid)
    if (closed) return
    const transport = shared.transportFor(channel.resourceId)
    const engine = createDirectoryReplica({ doc, channel, device: options.device, transport })
    const session = openSyncSession({
      engine,
      doc,
      transport,
      resourceId: channel.resourceId,
      readableEpochs: () => [],
      relay: relayWatch,
      canAuthor: true,
      recover: "publish-state",
    })
    doc.on("update", check)
    close = () => {
      doc.off("update", check)
      session.close()
      engine.close()
    }
  })()

  return {
    check,
    close: () => {
      closed = true
      close()
      doc.destroy()
    },
  }
}
