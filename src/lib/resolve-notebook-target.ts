import { isNoteNode, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { createNotebookIndexDoc, createNotebookSettingsDoc } from "@/lib/yjs-utils"

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
  let settingsHandle: ReturnType<typeof createNotebookSettingsDoc> | null = null
  try {
    settingsHandle = createNotebookSettingsDoc(notebookId)
    try {
      await settingsHandle.idb.whenSynced
    } catch {}
    const { settings } = settingsHandle
    const preferred = (settings.get("lastOpenedNoteId") as string | null) ?? null
    if (preferred) {
      return preferred
    }
  } catch (error) {
    console.error("Failed to read notebook settings", error)
  } finally {
    settingsHandle?.doc.destroy()
  }

  // Note: the index doc is cached per notebookId (see createNotebookIndexDoc),
  // so this doesn't destroy it — a live editor session or share dialog may
  // already be holding the same instance.
  try {
    const indexHandle = createNotebookIndexDoc(notebookId)
    try {
      await indexHandle.idb.whenSynced
    } catch {}
    const storedRoot = indexHandle.tree.get("root") as TreeNode | undefined
    const firstStored = findFirstNoteId(storedRoot)
    if (firstStored) return firstStored
  } catch (error) {
    console.error("Failed to read notebook index", error)
  }

  return findFirstNoteId(fallbackRoot)
}

export { findFirstNoteId }
