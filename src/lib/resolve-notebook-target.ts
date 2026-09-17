import { isNoteNode, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { createNotebookIndexDoc, readNotebookIndexTree } from "@/lib/yjs-utils"
import { getLastOpenedNoteId } from "@/lib/notebook-settings"

function findFirstNoteId(node?: TreeNode | null): string | null {
  if (!node) return null
  if (!node.isFolder) return isNoteNode(node) ? (node.id ?? null) : null
  const children = node.children || []
  for (const child of children) {
    const result = findFirstNoteId(child)
    if (result) return result
  }
  return null
}

export async function resolveNotebookTargetNote(
  notebookId: string,
  fallbackRoot?: TreeNode | null,
): Promise<string | null> {
  const preferred = getLastOpenedNoteId(notebookId)
  if (preferred) {
    return preferred
  }

  // Note: the index doc is cached per notebookId (see createNotebookIndexDoc),
  // so this doesn't destroy it — a live editor session or share dialog may
  // already be holding the same instance.
  try {
    const indexHandle = createNotebookIndexDoc(notebookId)
    try {
      await indexHandle.idb.whenSynced
    } catch {}
    const { root: storedRoot } = readNotebookIndexTree(indexHandle)
    const firstStored = findFirstNoteId(storedRoot)
    if (firstStored) return firstStored
  } catch (error) {
    console.error("Failed to read notebook index", error)
  }

  return findFirstNoteId(fallbackRoot)
}

export { findFirstNoteId }
