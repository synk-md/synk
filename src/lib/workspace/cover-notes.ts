/**
 * Making every note in a notebook readable to a device that has just been let
 * in: a baseline snapshot of each, under a key it holds, and the images each
 * shows - so it can open any note long after anyone holding it has gone.
 *
 * Shared by admitting a member and by linking someone's own device. Imported
 * by path rather than through the workspace barrel: it reaches IndexedDB.
 */

import * as Y from "yjs"

import { collectLeaves } from "@/components/custom-ui/file-browser/tree"
import type { DeviceIdentity } from "@/lib/identity"
import { NoteImageRefIndex } from "@/lib/note-image-refs"
import { createNotebookIndexDoc, getOrCreateYDoc, readNotebookIndexTree } from "@/lib/yjs-utils"

import { createSealer } from "./admission-sealer"
import { noteRefsFor } from "./admit-notes"
import { planAdmission, progressOf, runAdmissionPlan, type PlanProgress } from "./admission-plan"
import { readNotebookKeys } from "./notebook-keys"
import { relayConnection } from "./note-relay"
import { hasNoOperations } from "./note-snapshots"
import { noteResourceId } from "./note-sync"
import { publishHeldImage } from "./note-images"
import { storedCoverage } from "./stored-watermark"

export interface CoverNotesOptions {
  notebookId: string
  /** The device doing the work. It must be able to open `epoch`. */
  device: DeviceIdentity
  owner: string
  /** Who it is for. Names the plan, so an interrupted run resumes. */
  recipient: string
  epoch: number
  signal?: AbortSignal
  onStart?: (start: { progress: PlanProgress; noteIds: string[]; offThread: boolean }) => void
  onProgress?: (progress: PlanProgress) => void
}

export interface CoverResult {
  progress: PlanProgress
  /** Notes still unreadable to the recipient. Empty when complete. */
  outstanding: string[]
  offThread: boolean
}

export async function coverNotes(options: CoverNotesOptions): Promise<CoverResult> {
  const { notebookId, epoch } = options
  const shared = relayConnection()
  if (!shared) throw new Error("Encrypted sync is off, so there is nothing to cover.")

  const index = createNotebookIndexDoc(notebookId)
  await index.idb.whenSynced
  const noteIds = collectLeaves(readNotebookIndexTree(index).root).noteIds

  const keys = await readNotebookKeys({
    doc: index.doc,
    notebookId,
    device: options.device,
    owner: options.owner,
  })
  if (!keys.keyring) throw new Error("This device cannot open the notebook's keys.")
  const keyring = keys.keyring

  const sealer = createSealer(options.device.signingKey, options.device.did)
  try {
    const plan = planAdmission({
      notebookId,
      joiner: options.recipient,
      notes: noteRefsFor(notebookId, noteIds),
      epochs: { [keys.domain]: epoch },
    })
    options.onStart?.({ progress: progressOf(plan), noteIds, offThread: sealer.offThread })

    const finished = await runAdmissionPlan({
      plan,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (progress) => {
        options.onProgress?.(progress)
      },
      snapshot: async (task) => {
        const { doc, idb } = getOrCreateYDoc(notebookId, task.noteId)
        await idb.whenSynced
        // Nobody has written to it, so no author gap can exist.
        if (hasNoOperations(doc)) return false

        // Its images too, while the note is open anyway.
        const images = new NoteImageRefIndex(doc)
        await Promise.all(
          images.all().map((assetId) => publishHeldImage(notebookId, assetId).catch(() => undefined)),
        )
        images.destroy()

        const epochKey = await keyring.keyFor(epoch)
        if (!epochKey) throw new Error(`no key for epoch ${String(epoch)}`)

        const snapshot = await sealer.seal({
          domain: task.domain,
          resourceId: noteResourceId(notebookId, task.noteId),
          epoch,
          epochKey,
          state: Y.encodeStateAsUpdate(doc),
          // What this copy is known to contain, so the recipient fetches only
          // what came after it - not envelopes sealed under epochs it was
          // never given, which it could not open anyway.
          covers: await storedCoverage(idb),
          createdAt: Date.now(),
        })
        await shared.transportFor(noteResourceId(notebookId, task.noteId)).depositSnapshot(snapshot)
        return true
      },
    })

    return {
      progress: progressOf(finished),
      outstanding: finished.tasks
        .filter((task) => task.state === "pending" || task.state === "failed")
        .map((task) => task.noteId),
      offThread: sealer.offThread,
    }
  } finally {
    sealer.close()
  }
}
