import type { LinkAccess } from "@/lib/note-meta"

export type NodeId = string | null;

export type FileTreeSortOrder =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc"

export type TreeNode = {
  id: NodeId
  name: string
  isFolder: boolean
  expanded?: boolean
  isUserFolder?: boolean
  // Present on leaf nodes that represent an uploaded image rather than a note,
  // pointing at the content-hash key used in the image asset store.
  assetId?: string
  linkAccess?: LinkAccess
  isShared?: boolean
  createdAt?: number
  modifiedAt?: number
  // children is undefined if not yet fetched (lazy)
  children?: TreeNode[],
  hiddenRoot?: boolean
}

export type Notebook = {
  id: string;           // stable ID
  name: string;         // display name (used as hidden root label)
  root: TreeNode;       // your file tree root (hidden in UI)
  createdAt: number;
};

export type NotebooksState = {
  notebooks: Notebook[];
  currentId: string | null; // which notebook is open
};

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// A leaf node is a note only if it isn't a folder *and* isn't an image asset entry.
export function isNoteNode(node: TreeNode | null | undefined): boolean {
  return Boolean(node && !node.isFolder && !node.assetId)
}

// TODO: Optimize findNode / updateAtPath to avoid full tree traversal
export function findNode(
  tree: TreeNode,
  id: NodeId,
  path: number[] = []
): { node: TreeNode | null; path: number[] } {
  if (tree.id === id) return { node: tree, path }
  const kids = tree.children || []
  for (let i = 0; i < kids.length; i++) {
    const res = findNode(kids[i], id, [...path, i])
    if (res.node) return res
  }
  return { node: null, path: [] }
}

export function updateAtPath(
  tree: TreeNode,
  path: number[],
  updater: (n: TreeNode) => TreeNode
): TreeNode {
  if (path.length === 0) return updater(tree)
  const [idx, ...rest] = path
  const children = tree.children ? [...tree.children] : []
  children[idx] = updateAtPath(children[idx], rest, updater)
  return { ...tree, children }
}

export function insertNode(
  tree: TreeNode,
  parentId: NodeId,
  newNode: TreeNode
): TreeNode {
  if (!parentId) throw new Error("createNode: parentId cannot be null")
  const { node, path } = findNode(tree, parentId)
if (!node || !node.isFolder) return tree
  return updateAtPath(tree, path, (n) => {
    const children = n.children ? [newNode, ...n.children] : [newNode]
    return { ...n, children }
  })
}

// Splits a subtree's leaves into note ids (Yjs docs) and image asset ids
// (IndexedDB blobs), so deleting a folder/notebook cleans up both kinds of storage.
export function collectLeaves(
  node: TreeNode | null | undefined
): { noteIds: string[]; assetIds: string[] } {
  if (!node) return { noteIds: [], assetIds: [] }
  if (!node.isFolder) {
    if (node.assetId) return { noteIds: [], assetIds: [node.assetId] }
    return { noteIds: typeof node.id === "string" ? [node.id] : [], assetIds: [] }
  }
  return (node.children ?? []).reduce(
    (acc, child) => {
      const leaves = collectLeaves(child)
      acc.noteIds.push(...leaves.noteIds)
      acc.assetIds.push(...leaves.assetIds)
      return acc
    },
    { noteIds: [] as string[], assetIds: [] as string[] }
  )
}

export type SharedNoteEntry = {
  id: string
  name: string
  linkAccess: LinkAccess
}

// Walks a notebook's tree and returns every note (leaf, non-asset) that
// currently has link sharing enabled, used to populate "shared" dialog views.
export function collectSharedNotes(node: TreeNode | null | undefined): SharedNoteEntry[] {
  if (!node) return []
  if (!node.isFolder) {
    if (node.assetId) return []
    if (!node.linkAccess || node.linkAccess === "restricted") return []
    return [{ id: String(node.id), name: node.name, linkAccess: node.linkAccess }]
  }
  return (node.children ?? []).flatMap(collectSharedNotes)
}

export type NoteEntry = {
  id: string
  name: string
  path: string[]
}

// Flattens a tree into every note (leaf, non-asset, non-folder) with the
// names of its ancestor folders, used to power the note quick-switcher.
// `node` is always treated as a hidden root on the initial call, since
// callers pass the notebook's own root (whose name is the notebook name,
// not a meaningful folder in the note's path) regardless of `hiddenRoot`.
export function collectNoteEntries(
  node: TreeNode,
  ancestors: string[] = [],
  isRoot = true,
): NoteEntry[] {
  if (!node.isFolder) {
    if (node.assetId || typeof node.id !== "string") return []
    return [{ id: node.id, name: node.name || "Untitled", path: ancestors }]
  }

  const nextAncestors = isRoot || node.hiddenRoot ? ancestors : [...ancestors, node.name]
  return (node.children ?? []).flatMap((child) =>
    collectNoteEntries(child, nextAncestors, false),
  )
}

export type FolderEntry = {
  id: string
  name: string
  path: string[]
}

// Flattens a tree into the notebook root plus every folder (with the names
// of its ancestor folders), used to power the "Move to" folder picker.
// `node` is always treated as the hidden root, same as collectNoteEntries.
export function collectFolderEntries(node: TreeNode): FolderEntry[] {
  function walk(n: TreeNode, ancestors: string[]): FolderEntry[] {
    return (n.children ?? []).flatMap((child) => {
      if (!child.isFolder || typeof child.id !== "string") return []
      const entry: FolderEntry = { id: child.id, name: child.name || "Untitled", path: ancestors }
      return [entry, ...walk(child, [...ancestors, child.name || "Untitled"])]
    })
  }

  return [{ id: String(node.id), name: "/", path: [] }, ...walk(node, [])]
}

export function deleteNode(tree: TreeNode, id: NodeId): TreeNode {
  if (tree.id === id) return tree // don't delete root here
  function walk(n: TreeNode): TreeNode {
    const children = n.children
    if (!children) return n
    const next = children
      .filter((c) => c.id !== id)
      .map((c) => walk(c))
    return { ...n, children: next }
  }
  return walk(tree)
}

export function moveNode(
  tree: TreeNode,
  id: NodeId,
  parentId: NodeId
): TreeNode {
  if (!id || !parentId || tree.id === id || id === parentId) return tree

  const source = findNode(tree, id)
  const destination = findNode(tree, parentId)

  if (!source.node || !destination.node?.isFolder) return tree

  // Do not move a folder into itself or one of its descendants.
  if (source.node.isFolder && findNode(source.node, parentId).node) return tree

  const parentPath = source.path.slice(0, -1)
  const currentParent = parentPath.reduce<TreeNode | undefined>(
    (node, childIndex) => node?.children?.[childIndex],
    tree,
  )

  // Dragging onto the folder the note already belongs to is not a reorder.
  if (currentParent?.id === parentId) return tree

  const treeWithoutSource = deleteNode(tree, id)
  const nextDestination = findNode(treeWithoutSource, parentId)
  if (!nextDestination.node?.isFolder) return tree

  return updateAtPath(treeWithoutSource, nextDestination.path, (node) => ({
    ...node,
    expanded: true,
    children: [...(node.children ?? []), source.node!],
  }))
}

export function renameNode(
  tree: TreeNode,
  id: NodeId,
  name: string
): TreeNode {
  const { node, path } = findNode(tree, id)
  if (!node) return tree
  return updateAtPath(tree, path, (n) => ({ ...n, name, modifiedAt: Date.now() }))
}

export function setExpanded(
  tree: TreeNode,
  id: NodeId,
  expanded: boolean
): TreeNode {
  const { node, path } = findNode(tree, id)
  if (!node) return tree
  return updateAtPath(tree, path, (n) => ({ ...n, expanded }))
}

// Collapses every expanded folder in the tree, used by the file tree's
// "Collapse all" toolbar action.
export function collapseAll(tree: TreeNode): TreeNode {
  function walk(n: TreeNode): TreeNode {
    if (!n.isFolder) return n
    let changed = Boolean(n.expanded)
    const children = n.children?.map((child) => {
      const next = walk(child)
      if (next !== child) changed = true
      return next
    })
    if (!changed) return n
    return { ...n, expanded: false, children }
  }
  return walk(tree)
}

// Also called just to reconcile the tree's cached linkAccess/isShared with
// whatever a note's access already is every time that note is opened (see
// simple-editor.tsx) — not just when someone deliberately changes it. So it
// must never touch modifiedAt itself, or merely opening a note whose cached
// access hasn't caught up yet would bump modifiedAt and falsely mark it
// unread for every other collaborator. Callers that represent a genuine,
// deliberate access change (e.g. handleLinkAccessChange) touch modifiedAt
// themselves.
export function setNodeLinkAccess(
  tree: TreeNode,
  id: NodeId,
  linkAccess: LinkAccess,
): TreeNode {
  const { node, path } = findNode(tree, id)
  if (!node || node.isFolder || node.assetId) return tree

  const isShared = linkAccess !== "restricted"
  if (node.linkAccess === linkAccess && node.isShared === isShared) return tree

  return updateAtPath(tree, path, (n) => ({ ...n, linkAccess, isShared }))
}

export function touchNodeModifiedAt(
  tree: TreeNode,
  id: NodeId,
  modifiedAt = Date.now(),
): TreeNode {
  const { node, path } = findNode(tree, id)
  if (!node || node.isFolder || node.assetId) return tree

  return updateAtPath(tree, path, (n) => ({ ...n, modifiedAt }))
}

export function findAssetNode(
  tree: TreeNode,
  assetId: string,
  path: number[] = [],
): { node: TreeNode; path: number[] } | null {
  if (!tree.isFolder && tree.assetId === assetId) return { node: tree, path }
  for (let index = 0; index < (tree.children ?? []).length; index += 1) {
    const child = tree.children![index]
    const found = findAssetNode(child, assetId, [...path, index])
    if (found) return found
  }
  return null
}

function isGeneratedAssetName(name: string, assetId: string): boolean {
  const shortHash = assetId.startsWith("sha256:") ? assetId.slice(7, 15) : assetId
  return name === shortHash || name === `Image ${shortHash}`
}

// Finds the existing tree entry for `newAssetNode.assetId` (same image
// already uploaded elsewhere in this notebook), or inserts it into the
// notebook's Assets folder, creating that folder under `rootId` if needed.
export function ensureAssetNode(
  tree: TreeNode,
  rootId: NodeId,
  assetsFolderId: NodeId,
  newAssetNode: TreeNode,
): TreeNode {
  if (newAssetNode.assetId) {
    const existing = findAssetNode(tree, newAssetNode.assetId)
    if (existing) {
      if (
        newAssetNode.name &&
        existing.node.name !== newAssetNode.name &&
        isGeneratedAssetName(existing.node.name, newAssetNode.assetId)
      ) {
        return updateAtPath(tree, existing.path, (node) => ({
          ...node,
          name: newAssetNode.name,
        }))
      }

      return tree
    }
  }

  let next = tree
  if (!findNode(next, assetsFolderId).node) {
    next = insertNode(next, rootId, { id: assetsFolderId, name: "Assets", isFolder: true })
  }
  return insertNode(next, assetsFolderId, newAssetNode)
}

export function upsertChildren(
  tree: TreeNode,
  id: NodeId,
  kids: TreeNode[]
): TreeNode {
  const { node, path } = findNode(tree, id)
  if (!node) return tree
  return updateAtPath(tree, path, (n) => ({ ...n, children: kids }))
}

// A single node's own fields plus a parent reference, in place of nesting -
// the shape a tree is converted to/from so it can be persisted as one Yjs
// map entry per node (see yjs-utils.ts) instead of one blob for the whole
// tree. That's what lets concurrent edits to different notes merge
// independently instead of one replacing the other wholesale.
export type FlatNodeRecord = {
  parentId: string | null
  name: string
  isFolder: boolean
  expanded?: boolean
  isUserFolder?: boolean
  assetId?: string
  linkAccess?: LinkAccess
  isShared?: boolean
  createdAt?: number
  modifiedAt?: number
  hiddenRoot?: boolean
}

// Flattens a tree into an id -> record map. Nodes without a string id
// (shouldn't occur in a real notebook tree) are skipped, along with their
// subtree.
export function flattenTree(root: TreeNode): Map<string, FlatNodeRecord> {
  const out = new Map<string, FlatNodeRecord>()
  function walk(node: TreeNode, parentId: string | null) {
    if (typeof node.id !== "string") return
    const record: FlatNodeRecord = { parentId, name: node.name, isFolder: node.isFolder }
    if (node.expanded !== undefined) record.expanded = node.expanded
    if (node.isUserFolder !== undefined) record.isUserFolder = node.isUserFolder
    if (node.assetId !== undefined) record.assetId = node.assetId
    if (node.linkAccess !== undefined) record.linkAccess = node.linkAccess
    if (node.isShared !== undefined) record.isShared = node.isShared
    if (node.createdAt !== undefined) record.createdAt = node.createdAt
    if (node.modifiedAt !== undefined) record.modifiedAt = node.modifiedAt
    if (node.hiddenRoot !== undefined) record.hiddenRoot = node.hiddenRoot
    out.set(node.id, record)
    for (const child of node.children ?? []) walk(child, node.id)
  }
  walk(root, null)
  return out
}

// Inverse of flattenTree. The root is whichever record has parentId null
// (there should be exactly one, the node flattenTree started from) - no
// caller needs to know its id ahead of time. Folders always get a
// `children` array (possibly empty); leaves never do. Children are ordered
// by id for a stable (if arbitrary) order - actual display order is always
// applied separately by the file tree's sort order (see
// childrenBySortOrder in file-tree.tsx), so this doesn't need to preserve
// insertion order.
export function buildTreeFromFlat(flat: Map<string, FlatNodeRecord>): TreeNode | undefined {
  let rootId: string | undefined
  const childrenByParent = new Map<string, string[]>()
  for (const [id, record] of flat) {
    if (record.parentId === null) {
      rootId = id
      continue
    }
    const siblings = childrenByParent.get(record.parentId)
    if (siblings) siblings.push(id)
    else childrenByParent.set(record.parentId, [id])
  }
  if (rootId === undefined) return undefined
  for (const siblings of childrenByParent.values()) siblings.sort()

  function build(id: string): TreeNode | undefined {
    const record = flat.get(id)
    if (!record) return undefined
    const node: TreeNode = { id, name: record.name, isFolder: record.isFolder }
    if (record.expanded !== undefined) node.expanded = record.expanded
    if (record.isUserFolder !== undefined) node.isUserFolder = record.isUserFolder
    if (record.assetId !== undefined) node.assetId = record.assetId
    if (record.linkAccess !== undefined) node.linkAccess = record.linkAccess
    if (record.isShared !== undefined) node.isShared = record.isShared
    if (record.createdAt !== undefined) node.createdAt = record.createdAt
    if (record.modifiedAt !== undefined) node.modifiedAt = record.modifiedAt
    if (record.hiddenRoot !== undefined) node.hiddenRoot = record.hiddenRoot
    if (record.isFolder) {
      node.children = (childrenByParent.get(id) ?? [])
        .map(build)
        .filter((n): n is TreeNode => n !== undefined)
    }
    return node
  }

  return build(rootId)
}

function flatRecordsEqual(a: FlatNodeRecord, b: FlatNodeRecord): boolean {
  return (
    a.parentId === b.parentId &&
    a.name === b.name &&
    a.isFolder === b.isFolder &&
    a.expanded === b.expanded &&
    a.isUserFolder === b.isUserFolder &&
    a.assetId === b.assetId &&
    a.linkAccess === b.linkAccess &&
    a.isShared === b.isShared &&
    a.createdAt === b.createdAt &&
    a.modifiedAt === b.modifiedAt &&
    a.hiddenRoot === b.hiddenRoot
  )
}

export type FlatTreeDiff = {
  upserts: Array<[string, FlatNodeRecord]>
  deletes: string[]
}

// Diffs two flattened trees down to the individual nodes that actually
// changed (added, edited, or removed), so persisting an edit only touches
// the Yjs entry for the node(s) it affects instead of rewriting the whole
// tree - see yjs-utils.ts's writeNotebookIndexTree.
export function diffFlatTrees(
  prev: Map<string, FlatNodeRecord>,
  next: Map<string, FlatNodeRecord>,
): FlatTreeDiff {
  const upserts: Array<[string, FlatNodeRecord]> = []
  const deletes: string[] = []
  for (const [id, record] of next) {
    const before = prev.get(id)
    if (!before || !flatRecordsEqual(before, record)) upserts.push([id, record])
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) deletes.push(id)
  }
  return { upserts, deletes }
}
