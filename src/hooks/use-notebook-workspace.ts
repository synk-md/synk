"use client"

import * as React from "react"

import { currentDevice } from "@/lib/identity"
import {
  readNotebookWorkspace,
  workspaceIdFor,
  resourceIdFor,
  type NotebookWorkspace,
} from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

function empty(notebookId: string): NotebookWorkspace {
  return {
    notebookId,
    workspace: workspaceIdFor(notebookId),
    resource: resourceIdFor(notebookId),
    ownership: { status: "none", owner: null, genesis: null, claims: [] },
    directory: null,
    users: [],
    self: null,
  }
}

export interface NotebookWorkspaceState {
  workspace: NotebookWorkspace | null
  loading: boolean
}

/**
 * The notebook's owner and member set, re-read whenever the index document
 * changes.
 *
 * Every read re-verifies from scratch, which is the directory's whole contract:
 * a peer that writes a hostile record produces entries that fail verification
 * and are dropped, so there is nothing to cache and nothing to invalidate.
 */
export function useNotebookWorkspace(notebookId: string | null): NotebookWorkspaceState {
  const [state, setState] = React.useState<NotebookWorkspaceState>({
    workspace: null,
    loading: true,
  })

  React.useEffect(() => {
    if (!notebookId) {
      setState({ workspace: null, loading: false })
      return
    }

    let cancelled = false
    const { doc, idb } = createNotebookIndexDoc(notebookId)
    const selfDid = currentDevice()?.identity.did

    const read = () => {
      void readNotebookWorkspace({
        doc,
        notebookId,
        ...(selfDid === undefined ? {} : { selfDid }),
      })
        .then((workspace) => {
          if (!cancelled) setState({ workspace, loading: false })
        })
        .catch(() => {
          if (!cancelled) setState({ workspace: empty(notebookId), loading: false })
        })
    }

    void idb.whenSynced.then(read)
    doc.on("update", read)
    return () => {
      cancelled = true
      doc.off("update", read)
    }
  }, [notebookId])

  return state
}
