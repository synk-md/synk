import * as React from "react"
import { isNoteNode, type NodeId, type TreeNode } from "@/components/custom-ui/file-browser/tree"

const lastViewedKey = (noteId: string) => `noteLastViewedAt:${noteId}`

function getNoteLastViewedAt(noteId: string): number | null {
  const raw = localStorage.getItem(lastViewedKey(noteId))
  return raw ? Number(raw) : null
}

// Call when a note is opened, and again on every content update while it
// stays open — see the callers in simple-editor.tsx. Notes with no recorded
// timestamp are never flagged unread (see useUnreadNoteIds), so a note only
// starts being tracked once the current user has actually looked at it.
export function markNoteViewed(noteId: NodeId | null | undefined, at = Date.now()) {
  if (typeof noteId !== "string") return
  localStorage.setItem(lastViewedKey(noteId), String(at))
}

function collectNoteNodes(node: TreeNode | null | undefined, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out
  if (isNoteNode(node)) {
    out.push(node)
    return out
  }
  for (const child of node.children ?? []) collectNoteNodes(child, out)
  return out
}

// Notes edited since we last opened them, excluding whichever note is
// currently active — that one is being read live, so it's never "unread".
// A note we've never opened has no recorded lastViewedAt and is left out
// rather than treated as unread, so pre-existing notes don't all light up
// the moment this ships.
export function useUnreadNoteIds(
  tree: TreeNode | null | undefined,
  activeNoteId: NodeId | null | undefined,
): Set<NodeId> {
  return React.useMemo(() => {
    const ids = new Set<NodeId>()
    for (const node of collectNoteNodes(tree)) {
      if (!node.modifiedAt || node.id === activeNoteId || typeof node.id !== "string") continue
      const lastViewed = getNoteLastViewedAt(node.id)
      if (lastViewed !== null && node.modifiedAt > lastViewed) ids.add(node.id)
    }
    return ids
  }, [tree, activeNoteId])
}
