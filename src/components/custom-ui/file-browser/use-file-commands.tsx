// use-file-commands.ts
import * as React from "react"
import * as Y from "yjs"
import { collectLeaves, ensureAssetNode, findNode, isNoteNode, setNodeLinkAccess as setTreeNodeLinkAccess, type NodeId, type TreeNode } from "./tree"
import { deleteNoteFromIndexedDB, newNoteId as generateNodeId } from "@/lib/yjs-utils"
import {
  setNoteCreatedAt,
  setNoteTitle,
  setNoteLinkAccess,
  setNoteLinkAccessInherited,
  type LinkAccess,
} from "@/lib/note-meta"
import { deleteImageAsset } from "@/lib/image-assets"

type FSApi = {
  tree: TreeNode
  selectedId: NodeId | null
  createNode: (parentId: NodeId, node: { isFolder: boolean; name: string; id?: NodeId }) => NodeId
  expandFolder: (folderId: NodeId, expanded: boolean) => Promise<void> | void
  select: (id: NodeId) => Promise<void> | void
  remove: (id: NodeId) => void
  setTree: (updater: (t: TreeNode) => TreeNode) => void
}

type GetOrCreateYDocFn = (notebookId: string, noteId: string) => { doc: any; idb?: any }

export type UseFileCommandsOptions = {
  fallbackParentId: NodeId
  getNotebookId?: () => string
  getOrCreateYDoc?: GetOrCreateYDocFn
  seedNote?: string
  /** Current notebook-level link access, used to seed new notes so they're
   *  reachable through the notebook's share link from the moment they're
   *  created, instead of defaulting to "restricted". */
  getNotebookLinkAccess?: () => LinkAccess
}

export type FileCommands = {
  createNote: (name?: string, parentId?: NodeId) => Promise<NodeId>
  createFolder: (name?: string, parentId?: NodeId) => Promise<NodeId>
  deleteNode: (id: NodeId) => void
  duplicateNote: (id: NodeId) => Promise<NodeId | null>
  ensureImageAssetNode: (assetId: string, filename: string) => void
}

export function useFileCommands(fs: FSApi, opts: UseFileCommandsOptions): FileCommands {
  const { tree, selectedId, createNode, expandFolder, select, remove, setTree } = fs
  const { fallbackParentId, getNotebookId, getOrCreateYDoc, seedNote, getNotebookLinkAccess } = opts

  const isFolder = React.useCallback((id: NodeId | null) => {
    if (!id) return false
    const { node } = findNode(tree, id)
    return !!node?.isFolder
  }, [tree])

  const resolveParent = React.useCallback((override?: NodeId | null) => {
    if (override) return override
    return isFolder(selectedId) ? (selectedId as NodeId) : fallbackParentId
  }, [isFolder, selectedId, fallbackParentId])

  const initYDocIfConfigured = React.useCallback((noteId: string, title: string) => {
    const notebookAccess = getNotebookLinkAccess?.() ?? "restricted"
    if (!getOrCreateYDoc || !getNotebookId) return notebookAccess
    const notebookId = getNotebookId()
    const { doc } = getOrCreateYDoc(notebookId, noteId)
    const ytext = doc.getText("content")
    if (ytext.length === 0 && typeof seedNote === "string") ytext.insert(0, seedNote)

    const meta = doc.getMap("meta")
    setNoteCreatedAt(meta)
    setNoteTitle(meta, title)
    // New notes inherit the notebook's current access level (kept in sync
    // later by the notebook-level auto-sync) rather than defaulting to
    // "restricted" and silently not being reachable via the notebook's
    // own share link.
    setNoteLinkAccess(meta, notebookAccess)
    setNoteLinkAccessInherited(meta, true)
    return notebookAccess
  }, [getOrCreateYDoc, getNotebookId, seedNote, getNotebookLinkAccess])

  const ensureUniqueName = React.useCallback((parentId: NodeId, desiredName: string, isFolderNode: boolean) => {
    const normalizedName = desiredName.trim()
    const baseName = normalizedName.length ? normalizedName : desiredName
    const { node: parent } = findNode(tree, parentId)
    const siblings = parent?.children ?? []
    const siblingNames = new Set(
      siblings
        .filter((child) => child.isFolder === isFolderNode)
        .map((child) => child.name),
    )
    if (!siblingNames.has(baseName)) return baseName

    const match = baseName.match(/^(.*?)(?: (\d+))?$/)
    const rootName = match ? match[1].trim() : baseName.trim()
    const startingIndex = match && match[2] ? Number(match[2]) + 1 : 1
    let suffix = startingIndex
    let candidate = `${rootName} ${suffix}`.trim()

    while (siblingNames.has(candidate)) {
      suffix += 1
      candidate = `${rootName} ${suffix}`.trim()
    }

    return candidate
  }, [tree])

  const createNote = React.useCallback(async (name = "Untitled", parentOverride?: NodeId) => {
    const parentId = resolveParent(parentOverride)
    const uniqueName = ensureUniqueName(parentId, name, false)
    const newNoteId = createNode(parentId, { isFolder: false, name: uniqueName })
    await Promise.resolve(expandFolder(parentId, true))
    await Promise.resolve(select(newNoteId))
    const notebookAccess = initYDocIfConfigured(newNoteId as string, uniqueName)
    // Also stamp the tree node's own cached linkAccess. Unlike this note's
    // own per-note doc (only synced once someone actually opens it), the
    // tree syncs structurally via the notebook's own WebRTC room right
    // away — so other peers (e.g. the owner, for a note a guest just
    // created) can tell this note is meant to be collaborative before
    // they've ever opened it (see the matching fallback in simple-editor.tsx).
    setTree((t) => setTreeNodeLinkAccess(t, newNoteId, notebookAccess))
    return newNoteId
  }, [resolveParent, ensureUniqueName, createNode, expandFolder, select, initYDocIfConfigured, setTree])

  const createFolder = React.useCallback(async (name = "New folder", parentOverride?: NodeId) => {
    const parentId = resolveParent(parentOverride)
    const uniqueName = ensureUniqueName(parentId, name, true)
    const newFolderId = createNode(parentId, { isFolder: true, name: uniqueName })
    await Promise.resolve(expandFolder(parentId, true))
    await Promise.resolve(select(newFolderId))
    return newFolderId
  }, [resolveParent, ensureUniqueName, createNode, expandFolder, select])

  const deleteNode = React.useCallback((id: NodeId) => {
    if (!id) return
    if (!getNotebookId) return

    const { node } = findNode(tree, id)
    if (!node) return

    remove(id)

    const notebookId = getNotebookId()
    const { noteIds, assetIds } = collectLeaves(node)

    for (const noteId of noteIds) {
      void deleteNoteFromIndexedDB(notebookId, noteId).catch((err) => {
        console.error("Error deleting note from IndexedDB:", err)
      })
    }

    for (const assetId of assetIds) {
      void deleteImageAsset(assetId).catch((err) => {
        console.error("Error deleting image asset:", err)
      })
    }

}, [tree, remove, collectLeaves, getNotebookId])

  // Duplicates a note in place: new sibling tree entry plus a byte-for-byte
  // copy of the source Y.Doc state (content + meta), so formatting and any
  // embedded images carry over. Title/createdAt/linkAccess are then reset on
  // the copy so it doesn't masquerade as the original or inherit its share link.
  const duplicateNote = React.useCallback(async (id: NodeId) => {
    if (!id || !getNotebookId || !getOrCreateYDoc) return null

    const { node, path } = findNode(tree, id)
    if (!isNoteNode(node)) return null

    let parent = tree
    for (let i = 0; i < path.length - 1; i++) parent = parent.children![path[i]]
    const parentId = parent.id

    const copyName = ensureUniqueName(parentId, `${node!.name} copy`, false)
    const newNoteId = createNode(parentId, { isFolder: false, name: copyName })

    const notebookId = getNotebookId()
    const { doc: sourceDoc } = getOrCreateYDoc(notebookId, id as string)
    const { doc: destDoc } = getOrCreateYDoc(notebookId, newNoteId as string)
    Y.applyUpdate(destDoc, Y.encodeStateAsUpdate(sourceDoc))

    const meta = destDoc.getMap("meta")
    setNoteTitle(meta, copyName)
    setNoteCreatedAt(meta)
    setNoteLinkAccess(meta, "restricted")
    // Deliberately restricted, not just defaulted — mark it as a manual
    // override so the notebook-level auto-sync doesn't reshare it later.
    setNoteLinkAccessInherited(meta, false)

    await Promise.resolve(expandFolder(parentId, true))
    await Promise.resolve(select(newNoteId))

    return newNoteId
  }, [tree, getNotebookId, getOrCreateYDoc, ensureUniqueName, createNode, expandFolder, select])

  // Finds the existing tree entry for an already-uploaded image, or files a
  // new one under this notebook's Assets folder (created on first use).
  const ensureImageAssetNode = React.useCallback((assetId: string, filename: string) => {
    if (!getNotebookId) return
    if (!fallbackParentId) return
    const notebookId = getNotebookId()
    const assetsFolderId = `assets_${notebookId}`
    const now = Date.now()

    setTree((t) => ensureAssetNode(t, fallbackParentId, assetsFolderId, {
      id: generateNodeId(),
      name: filename,
      isFolder: false,
      assetId,
      createdAt: now,
      modifiedAt: now,
    }))
  }, [setTree, getNotebookId, fallbackParentId])

  return { createNote, createFolder, deleteNode, duplicateNote, ensureImageAssetNode }
}
