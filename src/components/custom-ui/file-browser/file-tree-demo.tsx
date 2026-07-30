// src/components/file-browser/FileTreeDemo.tsx
import React from "react"
import { FileTree } from "./file-tree"
import { useFileSystem } from "./use-file-system"
import { type TreeNode, type NodeId } from "./tree"

import "./file-tree.scss"
import "./editable-text.scss"
import "./file-tree-demo.scss"

export function FileTreeDemo() {
	const initialRoots: TreeNode[] = []
	const { tree, selectedId, expandFolder, createNode, rename, remove, select, setRoots } =
		useFileSystem({
			initialRoots,
			onAutosave: () => console.log("Autosave triggered ✅"),
		})

	const isEmpty =
		!tree ||
		(Array.isArray(tree) && tree.length === 0) ||
		(tree as any).children?.length === 0

	function handleOpenFolder(e: React.ChangeEvent<HTMLInputElement>) {
		const files = e.target.files
		if (!files || files.length === 0) return

		// Build a folder/file tree from webkitRelativePath
		type MutableNode = TreeNode & { children?: MutableNode[] }
		const rootMap = new Map<string, MutableNode>()

		for (const file of Array.from(files)) {
			// webkitRelativePath looks like: "MyFolder/sub/notes.txt"
			const rel = (file as any).webkitRelativePath || file.name
			const parts = rel.split("/").filter(Boolean)
			if (parts.length === 0) continue

			const top = parts[0]
			if (!rootMap.has(top)) {
				rootMap.set(top, { id: top, name: top, isFolder: true, expanded: true, children: [] })
			}

			let cursor = rootMap.get(top)!
			for (let i = 1; i < parts.length; i++) {
				const isLast = i === parts.length - 1
				const part = parts[i]
				if (isLast) {
					// file leaf
					cursor.children = cursor.children ?? []
					cursor.children.push({ id: rel, name: part, isFolder: false })
				} else {
					// ensure folder exists
					cursor.children = cursor.children ?? []
					let next = cursor.children.find(n => n.isFolder && n.name === part) as MutableNode | undefined
					if (!next) {
						next = { id: `${cursor.id}/${part}`, name: part, isFolder: true, expanded: false, children: [] }
						cursor.children.push(next)
					}
					cursor = next
				}
			}
		}


// Replace current roots with the imported folder(s)
		const newRoots = Array.from(rootMap.values())
		// If your hook exposes setRoots, use it; otherwise adapt to your API.
		setRoots ? setRoots(newRoots) : console.log("Roots to set:", newRoots)

		// reset input so the same folder can be chosen again
		e.currentTarget.value = ""
	}

	function handleCreate(parentId: NodeId, isFolder: boolean): string {
		const id = String(Math.floor(Math.random() * 10000))
		createNode(parentId, {
			id,
			name: isFolder ? "New Folder" : "Untitled",
			isFolder,
			expanded: isFolder,
			children: isFolder ? [] : undefined,
		})
		return id
	}

	return (
		<div className="file-tree-demo">
			<FileTree
				roots={Array.isArray(tree) ? tree : tree ? [tree] : []}
				selectedId={selectedId}
				onToggle={expandFolder}
				onCreate={handleCreate}
				onDelete={remove}
				onRename={rename}
				onSelect={(id) => {
					select(id)
					console.log("Selected:", id)
				}}
			/>

			{isEmpty && (
				<div className="empty-state">
					<p>No files yet</p>
					<label>
						Open Folder…
						<input
							type="file"
							multiple
							onChange={handleOpenFolder}
							style={{ display: "none" }}
							// @ts-ignore
							webkitdirectory=""
							// @ts-ignore
							directory=""
						/>
					</label>
				</div>
			)}

			{selectedId && (
				<div className="active-file">
					<p className="gray-text">Active File ID: {selectedId}</p>
				</div>
			)}
		</div>
	)
}
