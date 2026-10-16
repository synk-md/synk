"use client"

import * as React from "react"

import { currentDevice } from "@/lib/identity"
import { mayEditNote, readNotebookWorkspace } from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

/**
 * Whether this device may edit a note in a notebook it shares with others:
 * what everyone else will check its edits against. Null while unknown.
 *
 * Re-read as the notebook changes, so a level changed elsewhere reaches the
 * editor without a reload.
 */
export function useMayEditNote(notebookId: string | null, noteId: string | null): boolean | null {
  const [may, setMay] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    setMay(null)
    const device = currentDevice()
    if (!notebookId || !noteId || !device) return
    const { doc } = createNotebookIndexDoc(notebookId)
    let cancelled = false
    const check = () => {
      void (async () => {
        const workspace = await readNotebookWorkspace({ doc, notebookId })
        const owner = workspace.ownership.owner
        // Nobody established to grant anything: nothing to hold this device to.
        const next = owner ? await mayEditNote({ doc, notebookId, noteId, owner, did: device.identity.did }) : true
        if (!cancelled) setMay(next)
      })().catch((error: unknown) => {
        console.warn("edit access", error)
      })
    }
    doc.on("update", check)
    check()
    return () => {
      cancelled = true
      doc.off("update", check)
    }
  }, [notebookId, noteId])

  return may
}
