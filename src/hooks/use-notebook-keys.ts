"use client"

import * as React from "react"

import { currentDevice } from "@/lib/identity"
import { readNotebookKeys, type NotebookKeys } from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

export interface NotebookKeysState {
  keys: NotebookKeys | null
  loading: boolean
}

/**
 * This device's content keys for a notebook.
 *
 * Re-read on every document change, because a membership cut adds an epoch and
 * a sealed copy at the same time and a stale keyring is how a member ends up
 * sealing under a superseded epoch.
 *
 * Takes the owner rather than resolving it: the keys are only as trustworthy as
 * the admin set, and the admin set comes from ownership.
 */
export function useNotebookKeys(
  notebookId: string | null,
  owner: string | null,
): NotebookKeysState {
  const [state, setState] = React.useState<NotebookKeysState>({ keys: null, loading: true })

  React.useEffect(() => {
    const device = currentDevice()
    if (!notebookId || !device) {
      setState({ keys: null, loading: false })
      return
    }

    let cancelled = false
    const { doc, idb } = createNotebookIndexDoc(notebookId)

    const read = () => {
      void readNotebookKeys({ doc, notebookId, device: device.identity, owner })
        .then((keys) => {
          if (!cancelled) setState({ keys, loading: false })
        })
        .catch(() => {
          if (!cancelled) setState({ keys: null, loading: false })
        })
    }

    void idb.whenSynced.then(read)
    doc.on("update", read)
    return () => {
      cancelled = true
      doc.off("update", read)
    }
  }, [notebookId, owner])

  return state
}
