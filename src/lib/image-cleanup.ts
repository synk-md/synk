/**
 * Which images nobody uses any more, decided over what this device holds.
 *
 * An image is in use while a note this device holds shows it, or while a file
 * in some notebook's tree is it. An entry the app filed in a notebook's Assets
 * folder only because a note showed the image is not a use of its own: once no
 * note in that notebook shows it, the entry goes - but only where this device
 * holds every note the tree lists, since a note it lacks might show it.
 *
 * Deleting something lets its images go at once. Otherwise an image has to
 * stay unused for a grace period first, so undoing an edit, or restoring an
 * older version, finds it still here.
 *
 * Pure, so every rule can be tested without a browser.
 */

import { assetsFolderIdFor, collectLeaves, type TreeNode } from "@/components/custom-ui/file-browser/tree"

export interface NotebookView {
  notebookId: string
  /** The notebook's own tree, when this device has one. */
  root: TreeNode | undefined
  /** Images each note this device holds shows, by note id. */
  notes: ReadonlyMap<string, readonly string[]>
  /** Whether this device may change the tree. */
  writable: boolean
}

export interface CleanupInput {
  notebooks: readonly NotebookView[]
  /** Images shown by notes held under no notebook here. They still count. */
  strays: readonly string[]
  /** Images this device stores. */
  stored: readonly string[]
  /** When each image was first seen unused. */
  unusedSince: ReadonlyMap<string, number>
  now: number
  graceMs: number
  /** Images just let go by deleting something, in that notebook: they go now if nothing else uses them. */
  released?: { assetIds: ReadonlySet<string>; notebookId?: string }
}

export interface AssetsEntry {
  notebookId: string
  nodeId: string
  assetId: string
}

export interface CleanupPlan {
  deleteImages: string[]
  removeEntries: AssetsEntry[]
  /** Newly seen unused. */
  markUnused: string[]
  /** Seen unused before, and in use again or deleted now. */
  unmarkUnused: string[]
  /** What each notebook still uses, to keep at the relay. */
  inUse: Map<string, Set<string>>
}

function assetNodes(root: TreeNode | undefined): { node: TreeNode; parentId: string | null }[] {
  const found: { node: TreeNode; parentId: string | null }[] = []
  const walk = (node: TreeNode, parentId: string | null) => {
    if (!node.isFolder && node.assetId) found.push({ node, parentId })
    for (const child of node.children ?? []) walk(child, typeof node.id === "string" ? node.id : null)
  }
  if (root) walk(root, null)
  return found
}

export function planImageCleanup(input: CleanupInput): CleanupPlan {
  const used = new Set(input.strays)
  const inUse = new Map<string, Set<string>>()
  const stale: (AssetsEntry & { writable: boolean })[] = []

  for (const notebook of input.notebooks) {
    const shown = new Set([...notebook.notes.values()].flat())
    const complete =
      notebook.root !== undefined && collectLeaves(notebook.root).noteIds.every((noteId) => notebook.notes.has(noteId))
    const keep = new Set(shown)
    for (const { node, parentId } of assetNodes(notebook.root)) {
      const assetId = node.assetId as string
      const listed = node.listed === true && parentId === assetsFolderIdFor(notebook.notebookId)
      if (!listed || !complete || shown.has(assetId) || typeof node.id !== "string") keep.add(assetId)
      else stale.push({ notebookId: notebook.notebookId, nodeId: node.id, assetId, writable: notebook.writable })
    }
    inUse.set(notebook.notebookId, keep)
    for (const assetId of keep) used.add(assetId)
  }

  const released = input.released
  const removeEntries = stale
    .filter((entry) => entry.writable)
    .filter(
      (entry) =>
        !released ||
        (released.assetIds.has(entry.assetId) &&
          (released.notebookId === undefined || released.notebookId === entry.notebookId)),
    )
    .map(({ notebookId, nodeId, assetId }) => ({ notebookId, nodeId, assetId }))

  const deleteImages: string[] = []
  const markUnused: string[] = []
  const unmarkUnused: string[] = []
  for (const assetId of new Set(input.stored)) {
    const since = input.unusedSince.get(assetId)
    if (used.has(assetId)) {
      if (since !== undefined) unmarkUnused.push(assetId)
      continue
    }
    const due = released?.assetIds.has(assetId) === true || (since !== undefined && input.now - since >= input.graceMs)
    if (due) {
      deleteImages.push(assetId)
      if (since !== undefined) unmarkUnused.push(assetId)
    } else if (since === undefined) {
      markUnused.push(assetId)
    }
  }

  return { deleteImages, removeEntries, markUnused, unmarkUnused, inUse }
}
