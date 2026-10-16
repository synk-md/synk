"use client"

import * as React from "react"

import { currentDevice } from "@/lib/identity"
import { mayEditNote, mayEditTree, readNotebookWorkspace } from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

type Check = (options: { doc: ReturnType<typeof createNotebookIndexDoc>["doc"]; notebookId: string; owner: string; did: string }) => Promise<boolean>

/**
 * Whether this device may write something in a notebook it shares with
 * others: what everyone else will check its writes against. Null while
 * unknown. Re-read as the notebook changes, so a level changed elsewhere
 * reaches an open note without a reload.
 */
function useMayWrite(notebookId: string | null, key: string | null, check: Check): boolean | null {
  const [may, setMay] = React.useState<boolean | null>(null)
  const checkRef = React.useRef(check)
  checkRef.current = check

  React.useEffect(() => {
    setMay(null)
    const device = currentDevice()
    if (!notebookId || key === null || !device) return
    const { doc } = createNotebookIndexDoc(notebookId)
    let cancelled = false
    const run = () => {
      void (async () => {
        const workspace = await readNotebookWorkspace({ doc, notebookId })
        const owner = workspace.ownership.owner
        // Nobody established to grant anything: nothing to hold this device to.
        const next = owner ? await checkRef.current({ doc, notebookId, owner, did: device.identity.did }) : true
        if (!cancelled) setMay(next)
      })().catch((error: unknown) => {
        console.warn("edit access", error)
      })
    }
    doc.on("update", run)
    run()
    return () => {
      cancelled = true
      doc.off("update", run)
    }
  }, [notebookId, key])

  return may
}

/** Whether this device may edit a note. */
export function useMayEditNote(notebookId: string | null, noteId: string | null): boolean | null {
  return useMayWrite(notebookId, noteId, (options) => mayEditNote({ ...options, noteId: noteId ?? "" }))
}

/** Whether this device may change the notebook's notes and folders. */
export function useMayEditTree(notebookId: string | null): boolean | null {
  return useMayWrite(notebookId, "tree", mayEditTree)
}
