"use client"

import * as React from "react"

import { collectLeaves } from "@/components/custom-ui/file-browser/tree"
import { currentDevice } from "@/lib/identity"
import {
  createSealer,
  noteRefsFor,
  readNotebookKeys,
  relayConnection,
  runAdmissionPlan,
  planAdmission,
  progressOf,
  noteResourceId,
  type PlanProgress,
} from "@/lib/workspace"
import { NoteImageRefIndex } from "@/lib/note-image-refs"
import { hasNoOperations } from "@/lib/workspace"
import { publishHeldImage } from "@/lib/workspace/note-images"
import { storedCoverage } from "@/lib/workspace/stored-watermark"
import { createNotebookIndexDoc, getOrCreateYDoc, readNotebookIndexTree } from "@/lib/yjs-utils"
import * as Y from "yjs"

export interface AdmissionRun {
  /** Null until an admission is running or has finished. */
  progress: PlanProgress | null
  running: boolean
  error: string | null
  /** Note ids still deaf to pre-existing authors. Empty when complete. */
  outstanding: string[]
  /** True when the sealing is actually leaving the main thread. */
  offThread: boolean
}

const IDLE: AdmissionRun = {
  progress: null,
  running: false,
  error: null,
  outstanding: [],
  offThread: false,
}

/**
 * Covering a notebook's notes for a member who has just been admitted.
 *
 * Granting membership is one record; making it usable touches every note. This
 * drives that work: the plan and its persistence stay here, the sealing goes to
 * a worker, and the snapshots are deposited over the connection the app already
 * holds.
 *
 * Reported rather than awaited by whoever granted membership. The grant is
 * already published and valid; the baselines are what make it *useful*, and a
 * dialog that blocked on two hundred notes would look broken.
 */
export function useNoteAdmission(notebookId: string | null) {
  const [run, setRun] = React.useState<AdmissionRun>(IDLE)
  const abort = React.useRef<AbortController | null>(null)

  React.useEffect(
    () => () => {
      abort.current?.abort()
    },
    [],
  )

  const cover = React.useCallback(
    async (joinerDid: string, epoch: number): Promise<void> => {
      const device = currentDevice()
      const shared = relayConnection()
      if (!notebookId || !device) return
      if (!shared) {
        setRun({ ...IDLE, error: "Encrypted sync is off, so there is nothing to cover." })
        return
      }

      const controller = new AbortController()
      abort.current = controller

      const index = createNotebookIndexDoc(notebookId)
      await index.idb.whenSynced
      const { root } = readNotebookIndexTree(index)
      const noteIds = collectLeaves(root).noteIds

      const keys = await readNotebookKeys({
        doc: index.doc,
        notebookId,
        device: device.identity,
        owner: device.identity.did,
      })
      if (!keys.keyring) {
        setRun({ ...IDLE, error: "This device cannot open the notebook's keys." })
        return
      }

      const sealer = createSealer(device.identity.signingKey, device.identity.did)
      const domain = keys.domain
      const plan = planAdmission({
        notebookId,
        joiner: joinerDid,
        notes: noteRefsFor(notebookId, noteIds),
        epochs: { [domain]: epoch },
      })

      setRun({
        progress: progressOf(plan),
        running: true,
        error: null,
        outstanding: noteIds,
        offThread: sealer.offThread,
      })

      try {
        const finished = await runAdmissionPlan({
          plan,
          signal: controller.signal,
          onProgress: (progress) => {
            setRun((previous) => ({ ...previous, progress }))
          },
          snapshot: async (task) => {
            const { doc, idb } = getOrCreateYDoc(notebookId, task.noteId)
            await idb.whenSynced
            // Nobody has written to it, so no author gap can exist.
            if (hasNoOperations(doc)) return false

            // Its images too, while the note is open anyway: the joiner may
            // open it long after the last person holding them has gone.
            const images = new NoteImageRefIndex(doc)
            await Promise.all(
              images.all().map((assetId) => publishHeldImage(notebookId, assetId).catch(() => undefined)),
            )
            images.destroy()

            const epochKey = await keys.keyring!.keyFor(epoch)
            if (!epochKey) throw new Error(`no key for epoch ${String(epoch)}`)

            const snapshot = await sealer.seal({
              domain: task.domain,
              resourceId: noteResourceId(notebookId, task.noteId),
              epoch,
              epochKey,
              state: Y.encodeStateAsUpdate(doc),
              // What this copy is known to contain, so the joiner fetches only
              // what came after it - not envelopes sealed under epochs it was
              // never given, which it could not open anyway.
              covers: await storedCoverage(idb),
              createdAt: Date.now(),
            })
            await shared
              .transportFor(noteResourceId(notebookId, task.noteId))
              .depositSnapshot(snapshot)
            return true
          },
        })

        sealer.close()
        setRun({
          progress: progressOf(finished),
          running: false,
          error: null,
          outstanding: finished.tasks
            .filter((task) => task.state === "pending" || task.state === "failed")
            .map((task) => task.noteId),
          offThread: sealer.offThread,
        })
      } catch (error) {
        sealer.close()
        setRun((previous) => ({
          ...previous,
          running: false,
          error: error instanceof Error ? error.message : "Could not cover the notes.",
        }))
      }
    },
    [notebookId],
  )

  const cancel = React.useCallback(() => {
    abort.current?.abort()
  }, [])

  return { run, cover, cancel }
}
