"use client"

import * as React from "react"

import { currentDevice } from "@/lib/identity"
import { relayConnection, type PlanProgress } from "@/lib/workspace"
import { coverNotes } from "@/lib/workspace/cover-notes"

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
      if (!notebookId || !device) return
      if (!relayConnection()) {
        setRun({ ...IDLE, error: "Encrypted sync is off, so there is nothing to cover." })
        return
      }

      const controller = new AbortController()
      abort.current = controller

      try {
        const result = await coverNotes({
          notebookId,
          device: device.identity,
          // Admitting is the owner's act, so the owner is this device.
          owner: device.identity.did,
          recipient: joinerDid,
          epoch,
          signal: controller.signal,
          onStart: ({ progress, noteIds, offThread }) => {
            setRun({ progress, running: true, error: null, outstanding: noteIds, offThread })
          },
          onProgress: (progress) => {
            setRun((previous) => ({ ...previous, progress }))
          },
        })
        setRun({ ...result, running: false, error: null })
      } catch (error) {
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
