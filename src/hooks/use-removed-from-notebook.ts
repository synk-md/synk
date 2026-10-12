"use client"

import { useNotebookWorkspace } from "@/hooks/use-notebook-workspace"
import { currentDevice } from "@/lib/identity"

/**
 * Whether an admin has removed this device from the notebook.
 *
 * Read from the directory on its own rather than from the sync hooks. Once a
 * device is removed, the notebook no longer counts it as a member, so from its
 * side the notebook looks unshared - and everything that only runs for shared
 * notebooks, including noticing the removal, stops.
 */
export function useRemovedFromNotebook(notebookId: string | null): boolean {
  const { workspace } = useNotebookWorkspace(notebookId)
  const did = currentDevice()?.identity.did
  return Boolean(did && workspace?.directory?.removed.has(did))
}
