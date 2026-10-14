/**
 * Linking a new device into every notebook at once, and the new device
 * collecting them - each side doing its part through the relay, so neither
 * needs the other online when it acts.
 *
 * Imported by path, not through the workspace barrel: it reaches IndexedDB.
 */

import * as Y from "yjs"

import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import type { Bytes } from "@/lib/crypto"
import type { DeviceIdentity, DeviceRecord } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import type { SyncEngine, Transport } from "@/lib/sync"
import { createNotebookIndexDoc, readNotebookIndexTree, unsentFlag } from "@/lib/yjs-utils"

import { coverNotes } from "./cover-notes"
import { linkIntoNotebook } from "./linking"
import { readNotebookKeys } from "./notebook-keys"
import { readNotebookWorkspace } from "./notebook-workspace"
import { liveKeys, relayConnection, relayWatch } from "./note-relay"
import { pairingChannel, type PairedNotebook } from "./pairing"
import { createDirectoryReplica, createTreeReplica, directoryChannel, treeResourceId } from "./replicas"
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
    engine: createDirectoryReplica({ doc: handle.doc, channel, device, transport }),
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
      const handle = createNotebookIndexDoc(notebook.id)
      await handle.idb.whenSynced
      await linkIntoNotebook({ doc: handle.doc, notebookId: notebook.id, parent: options.device, record: options.record })
      const owner = await ownerOf(notebook.id, options.device)
      const keyring = owner ? await readableKeys(notebook.id, options.device, owner) : null
      if (!owner || !keyring) throw new Error("this device cannot open the notebook's keys")

      if (!(await syncDirectory(notebook.id, options.device))) throw new Error("could not reach the relay")
      await syncTree(notebook.id, options.device, owner, keyring)
      await coverNotes({
        notebookId: notebook.id,
        device: options.device,
        owner,
        recipient: options.record.did,
        epoch: keyring.currentEpoch,
      })
      linked.push(notebook)
    } catch (error) {
      skipped.push({ ...notebook, reason: error instanceof Error ? error.message : "could not be linked" })
    }
    done += 1
  }
  return { linked, skipped }
}

/**
 * The new device's side: the notebook's directory until this device holds its
 * keys, then the tree until there is one to show. Null when it does not arrive.
 */
export async function fetchNotebook(notebookId: string, device: DeviceIdentity): Promise<TreeNode | null> {
  const handle = createNotebookIndexDoc(notebookId)
  await handle.idb.whenSynced
  let owner: string | null = null
  let keyring: ReadKeySource | null = null
  const linked = await syncDirectory(notebookId, device, async () => {
    owner ??= await ownerOf(notebookId, device)
    keyring = owner ? await readableKeys(notebookId, device, owner) : null
    return keyring !== null
  })
  if (!linked || !owner || !keyring) return null
  const arrived = () => readNotebookIndexTree(handle).root !== undefined
  await syncTree(notebookId, device, owner, keyring, arrived)
  return readNotebookIndexTree(handle).root ?? null
}
