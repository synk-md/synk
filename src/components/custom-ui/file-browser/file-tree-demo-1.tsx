// src/components/file-browser/FileTreeDemo.tsx
import { FileTree } from "./file-tree"
import { useFileSystem } from "./use-file-system"
import { type TreeNode, type NodeId } from "./tree"

import './file-tree.scss'
import './editable-text.scss'

export function FileTreeDemo() {
  // Fake root with some children to start
  const initialRoots: TreeNode[] = [
  {
    id: "notes", // unique id (string or number)
    name: "Notes",
    isFolder: true,
    expanded: true,
    children: [
      { id: "todo", name: "todos", isFolder: true, expanded: false, children: [
        { id: "task1", name: "Task 1", isFolder: false },
        { id: "task2", name: "Task 2", isFolder: false },
      ] },
      { id: "ideas", name: "Ideas", isFolder: false },
    ],
  },
  {
    id: "drafts",
    name: "Drafts",
    isFolder: true,
    expanded: false,
    children: [
      { id: "ch1", name: "Chapter 1", isFolder: false },
      { id: "ch2", name: "Chapter 2", isFolder: false },
    ],
  },
  {
    id: "readme",
    name: "README",
    isFolder: false,
  },
]
  // useFileSystem hook manages state + selection
  const { tree, selectedId, expandFolder, createNode, rename, remove, select } =
    useFileSystem({
      initialRoots,
      onAutosave: () => console.log("Autosave triggered ✅"),
    })

  // Create handler (adds new folder/file under parent)
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
    <div style={{ width: 300, fontFamily: "sans-serif" }}>
      <FileTree
        roots={[tree]}
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
      {selectedId && (
        <div style={{ marginTop: 16, padding: 8 }}>
          <p className="gray-text">Active File ID: {selectedId}</p>
        </div>
      )}
    </div>
  )
}
