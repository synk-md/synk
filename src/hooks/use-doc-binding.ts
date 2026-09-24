"use client"

import * as React from "react"

import type { DocBinding } from "@/lib/doc-binding"
import { onDocBinding } from "@/lib/yjs-utils"

const UNBOUND: DocBinding = {
  docId: "",
  status: "unidentified",
  clientId: null,
  clock: null,
  detail: null,
}

/**
 * Whether this tab may write to a note, and why not when it may not.
 *
 * Starts optimistic: the client id is pinned synchronously, so the common case
 * never flickers into read-only while the lock and the clock check settle.
 */
export function useDocBinding(notebookId: string | null, noteId: string | null): DocBinding {
  const [binding, setBinding] = React.useState<DocBinding>(UNBOUND)

  React.useEffect(() => {
    if (!notebookId || !noteId) {
      setBinding(UNBOUND)
      return
    }
    return onDocBinding(notebookId, noteId, setBinding)
  }, [notebookId, noteId])

  return binding
}

/**
 * `unidentified` still writes. Local editing never depended on having an
 * identity, and refusing to edit because a key store was unavailable would
 * trade a degraded feature for a dead one.
 */
export function canWriteWith(binding: DocBinding): boolean {
  return binding.status === "writer" || binding.status === "unidentified"
}
