// src/components/file-browser/use-file-system.ts
import * as React from "react"
import {
	type TreeNode,
	type NodeId,
	insertNode,
	deleteNode as removeNode,
	moveNode as applyMove,
	renameNode as applyRename,
	setExpanded,
	collapseAll as applyCollapseAll,
	upsertChildren,
	findNode,
} from "./tree"

import { newNoteId as newNodeId } from "@/lib/yjs-utils"

type HiddenRoot = { hiddenRoot?: boolean }
type TNode = TreeNode & HiddenRoot

export type FetchFn = (folderId: NodeId, token?: string) => Promise<TreeNode[]>

export function useFileSystem(options: {
	root?: TreeNode
	onRootChange?: (newRoot: TreeNode) => void

	initialRoot?: TreeNode
	initialRoots?: TreeNode[]
	fetchChildren?: FetchFn // async fetcher for lazy-loading children
	authToken?: string
	onAutosave?: () => Promise<void> | void
} = {}) {
	const { root, onRootChange, initialRoot, initialRoots, fetchChildren, authToken, onAutosave } = options

	const initialTree: TNode = React.useMemo(() => {
		if (root) return root as TNode
		if (initialRoots && initialRoots.length) {
			return {
				id: "__root__", name: "Workspace", isFolder: true, expanded: true,
				children: initialRoots, hiddenRoot: true,
			}
		}
		if (initialRoot) return initialRoot as TNode
		return { id: "__root__", name: "Workspace", isFolder: true, expanded: true, children: [], hiddenRoot: true }
	}, [root, initialRoot, initialRoots])

	const onRootChangeRef = React.useRef(onRootChange)
	React.useEffect(() => {
		onRootChangeRef.current = onRootChange
	}, [onRootChange])

	const [tree, setTree] = React.useState<TNode>(initialTree)
	const [selectedId, setSelectedId] = React.useState<NodeId | null>(null)
	const modifiedRef = React.useRef(false)

	const containsNode = React.useCallback((t: TNode, id: NodeId | null) => {
		if (!id) return false
		return !!findNode(t, id).node
	}, [])

	// Syncs internal tree state when root prop changes, dropping selection if needed.
	React.useEffect(() => {
		const next = (root as TNode) ?? initialTree
		setTree(next)
		// drop selection if node not found in new root
		setSelectedId(prev => (containsNode(next, prev) ? prev : null))
	}, [root, initialTree, containsNode])

	const pendingNotifyRef = React.useRef(false)

	// Internal state updater that also marks the tree as modified if changed.
	// Wrapper for setTree with change detection and autosave support.
	const setTreeMarked = React.useCallback((updater: (t: TNode) => TNode) => {
		setTree((prev) => {
			const next = updater(prev)
			if (next !== prev) {
				modifiedRef.current = true
				pendingNotifyRef.current = true
			}
			return next
		})
	}, [])

	// setState updater functions can run during render (e.g. under Strict Mode
	// double-invoking, or while another component is rendering), so calling
	// onRootChange there can update a different component mid-render. Defer
	// the notification to an effect, which only runs after commit.
	React.useEffect(() => {
		if (pendingNotifyRef.current) {
			pendingNotifyRef.current = false
			onRootChangeRef.current?.(tree as TreeNode)
		}
	}, [tree])

	// Lazily loads a folder’s children if not already present exactly once using fetchChildren if configured.
	const ensureChildren = React.useCallback(
		async (folderId: NodeId) => {
			if (!fetchChildren) return
			const { node } = findNode(tree, folderId)
			if (!node) return
			if (typeof node.children !== "undefined") return
			const kids = await fetchChildren(folderId, authToken)
			setTreeMarked((t) => upsertChildren(t, folderId, kids) as TNode)
		},
		[tree, fetchChildren, authToken, setTreeMarked]
	)

	// Expand/collapse a folder, fetching children if needed
	const expandFolder = React.useCallback(
		async (folderId: NodeId, expanded: boolean) => {
			if (expanded) await ensureChildren(folderId)
			setTreeMarked((t) => setExpanded(t, folderId, expanded) as TNode)
		},
		[ensureChildren, setTreeMarked]
	)

	// Collapses every expanded folder in the tree.
	const collapseAll = React.useCallback(
		() => setTreeMarked((t) => applyCollapseAll(t) as TNode),
		[setTreeMarked]
	)

	// Inserts a child node under parentId.
	const createNode = React.useCallback(
		(parentId: NodeId, node: Omit<TreeNode, "id"> & { id?: NodeId }) => {
			const id = node.id ?? newNodeId()
			const now = Date.now()
			const fullNode: TreeNode = {
				...node,
				id,
				createdAt: node.createdAt ?? now,
				modifiedAt: node.modifiedAt ?? now,
			}
			setTreeMarked((t) => insertNode(t, parentId, fullNode) as TNode)
			return id // Can be used to select it right after creation
		},
		[setTreeMarked]
	)

	const rename = React.useCallback(
		(id: NodeId, name: string) => setTreeMarked((t) => applyRename(t, id, name) as TNode),
		[setTreeMarked]
	)

	const remove = React.useCallback(
		(id: NodeId) => setTreeMarked((t) => removeNode(t, id) as TNode),
		[setTreeMarked]
	)

	const move = React.useCallback(
		(id: NodeId, parentId: NodeId) =>
			setTreeMarked((t) => applyMove(t, id, parentId) as TNode),
		[setTreeMarked]
	)

	// If onAutosave is provided, call it before changing selection if there are unsaved changes.
	const select = React.useCallback(
		async (id: NodeId) => {
			if (modifiedRef.current && onAutosave) await onAutosave()
			modifiedRef.current = false
			setSelectedId(id)
		},
		[onAutosave]
	)

	// Support for multiple roots by wrapping them in a synthetic hidden root.
	const setRoots = React.useCallback((newRoots: TreeNode[]) => {
		setTreeMarked((t) => {
			// If we already have a synthetic hidden root, just replace its children.
			if (t?.hiddenRoot) {
				return { ...t, children: newRoots } as TNode
			}
			// Otherwise, wrap the existing single-root tree into a synthetic root.
			return {
                id: "__root__",
                name: "Workspace",
                isFolder: true,
                expanded: true,
                children: newRoots,
                hiddenRoot: true,
            } as TNode
		})
	}, [setTreeMarked])

	// Replaces the whole tree with a single visible root.
	const setRoot = React.useCallback((newRoot: TreeNode) => {
		setTreeMarked(() => newRoot as TNode)
	}, [setTreeMarked])

	return {
		// expose as single-tree API (root may be hidden synthetic)
		tree,
		setTree: setTreeMarked,
		setRoots,      // 🔸 export
		setRoot,       // 🔸 optional helper
		selectedId,
		expandFolder,
		collapseAll,
		createNode,
		rename,
		remove,
		move,
		select,
	}
}
