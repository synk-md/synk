/**
 * Deleting images nobody uses, on this device, and keeping the ones members
 * still use at the relay.
 *
 * The relay is never asked to delete: it drops what nobody renews, so here
 * every notebook shared with members renews what its notes still show, and
 * puts back anything the relay lost that this device holds.
 *
 * Imported by path rather than through the workspace barrel: it reaches
 * IndexedDB.
 */

import { planImageCleanup, type CleanupPlan, type NotebookView } from "@/lib/image-cleanup"
import { currentDevice } from "@/lib/identity"
import {
  deleteImageAsset,
  getImageAsset,
  listImageAssets,
  readUnusedSince,
  writeUnusedSince,
} from "@/lib/image-assets"
import { imageIdsIn } from "@/lib/note-image-refs"
import { createNotebookIndexDoc, readNotebookIndexTree, readStoredNote, storedDocuments } from "@/lib/yjs-utils"

import { hasAdmittedMembers } from "./admission"
import { publishImage, renewImages } from "./images"
import { relayBlobs } from "./note-images"
import { hasNoOperations } from "./note-snapshots"
import { readNotebookWorkspace } from "./notebook-workspace"
import { mayEditTree } from "./sharing"

/** How long an image stays unused before it is deleted, unless something holding it was. */
export const IMAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000
const EVERY_MS = 24 * 60 * 60 * 1000
const LAST_RUN_KEY = "synk:image-upkeep"
const UPKEEP_ORIGIN = Symbol("image-upkeep")

export interface UpkeepOptions {
  /** Images just let go by deleting something: they go now if nothing else uses them. */
  released?: { assetIds: Iterable<string>; notebookId?: string }
  /** Renew at the relay too. Off for a run straight after a delete. */
  renew?: boolean
  now?: number
  graceMs?: number
}

export interface UpkeepResult {
  plan: CleanupPlan
  deleted: string[]
  republished: number
}

let queue: Promise<unknown> = Promise.resolve()

/** One run at a time, so two never decide over the same images. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Images the given notes show. Read before deleting them, to release after. */
export async function imagesShownBy(notebookId: string, noteIds: readonly string[]): Promise<string[]> {
  const shown = new Set<string>()
  for (const noteId of noteIds) {
    for (const assetId of await readStoredNote(notebookId, noteId, imageIdsIn).catch(() => [])) shown.add(assetId)
  }
  return [...shown]
}

async function mayTidy(doc: ReturnType<typeof createNotebookIndexDoc>["doc"], notebookId: string): Promise<boolean> {
  const device = currentDevice()
  if (!device) return false
  const owner = (await readNotebookWorkspace({ doc, notebookId })).ownership.owner
  // Nobody established: a copy this device may only be looking at.
  if (!owner) return false
  return mayEditTree({ doc, notebookId, owner, did: device.identity.did })
}

export function upkeepImages(options: UpkeepOptions = {}): Promise<UpkeepResult | null> {
  return serially(async () => {
    const startedAt = Date.now()
    const now = options.now ?? startedAt
    const stored = await storedDocuments()
    if (!stored) return null

    const notebooks = new Map<string, { view: NotebookView; index: ReturnType<typeof createNotebookIndexDoc> }>()
    for (const notebookId of stored.notebooks) {
      const index = createNotebookIndexDoc(notebookId)
      await index.idb.whenSynced
      notebooks.set(notebookId, {
        index,
        view: { notebookId, root: readNotebookIndexTree(index).root, notes: new Map(), writable: await mayTidy(index.doc, notebookId) },
      })
    }

    const strays = new Set<string>()
    for (const { notebookId, noteId } of stored.notes) {
      const read = await readStoredNote(notebookId, noteId, (doc) => (hasNoOperations(doc) ? null : imageIdsIn(doc)))
      const notes = notebooks.get(notebookId)?.view.notes as Map<string, readonly string[]> | undefined
      // A note with nothing in it yet is not one this device can vouch for.
      if (read && notes) notes.set(noteId, read)
      else for (const assetId of read ?? []) strays.add(assetId)
    }

    const plan = planImageCleanup({
      notebooks: [...notebooks.values()].map((each) => each.view),
      strays: [...strays],
      stored: (await listImageAssets()).map((asset) => asset.id),
      unusedSince: await readUnusedSince(),
      now,
      graceMs: options.graceMs ?? IMAGE_GRACE_MS,
      ...(options.released
        ? {
            released: {
              assetIds: new Set(options.released.assetIds),
              ...(options.released.notebookId === undefined ? {} : { notebookId: options.released.notebookId }),
            },
          }
        : {}),
    })

    for (const [notebookId, { index }] of notebooks) {
      const entries = plan.removeEntries.filter((entry) => entry.notebookId === notebookId)
      if (entries.length === 0) continue
      index.tree.transact(() => {
        for (const entry of entries) {
          // Only if it is still the entry the plan saw.
          const record = index.nodes.get(entry.nodeId)
          if (record?.assetId === entry.assetId && record.listed) index.nodes.delete(entry.nodeId)
        }
      }, UPKEEP_ORIGIN)
    }

    // Stored again while this ran - uploaded anew, so in use after all.
    const fresh = new Set(
      (await listImageAssets()).filter((asset) => asset.createdAt >= startedAt).map((asset) => asset.id),
    )
    const deleted = []
    for (const assetId of plan.deleteImages) {
      if (fresh.has(assetId)) continue
      await deleteImageAsset(assetId)
      deleted.push(assetId)
    }
    await writeUnusedSince(plan.markUnused, now, plan.unmarkUnused)

    let republished = 0
    const blobs = options.renew === false ? null : relayBlobs()
    if (blobs) {
      for (const [notebookId, { index }] of notebooks) {
        if (!hasAdmittedMembers(index.doc)) continue
        try {
          for (const assetId of await renewImages(blobs, notebookId, [...(plan.inUse.get(notebookId) ?? [])])) {
            const asset = await getImageAsset(assetId)
            if (!asset) continue
            const bytes = new Uint8Array(await asset.blob.arrayBuffer())
            if ((await publishImage(blobs, notebookId, assetId, bytes)) === "stored") republished += 1
          }
        } catch (error) {
          console.warn("Could not renew images at the relay", error)
        }
      }
    }

    return { plan, deleted, republished }
  })
}

/** Images let go by deleting something: deleted now unless something else uses them. */
export function releaseImages(assetIds: Iterable<string>, notebookId?: string): Promise<UpkeepResult | null> {
  const released = [...assetIds]
  if (released.length === 0) return Promise.resolve(null)
  return upkeepImages({ released: { assetIds: released, ...(notebookId === undefined ? {} : { notebookId }) }, renew: false })
}

/** A run a day, the first shortly after start. Returns a stop. */
export function startImageUpkeep(): () => void {
  const tick = () => {
    try {
      const last = Number(localStorage.getItem(LAST_RUN_KEY) ?? 0)
      if (Date.now() - last < EVERY_MS) return
      localStorage.setItem(LAST_RUN_KEY, String(Date.now()))
    } catch {
      // No storage: run anyway, at most hourly.
    }
    void upkeepImages().catch((error: unknown) => {
      console.warn("Image upkeep failed", error)
    })
  }
  const first = setTimeout(tick, 30_000)
  const every = setInterval(tick, 60 * 60 * 1000)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
