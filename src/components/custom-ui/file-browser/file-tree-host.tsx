import { useNotebooks } from "@/hooks/use-notebooks";
import { FileTree, type FileTreeHandle  } from "@/components/custom-ui/file-browser/file-tree";
import type { FileTreeSortOrder, NodeId, TreeNode } from "@/components/custom-ui/file-browser/tree";
import type { NoteExportFormat } from "@/lib/note-export";
import type { NoteImportItem } from "@/lib/note-import";
import type { NotePresenceMap } from "@/hooks/use-note-presence";

import './file-tree.scss'
import './editable-text.scss'
import { forwardRef } from "react";

type HiddenRoot = TreeNode & { hiddenRoot?: boolean };

type FileTreeHostProps = {
  selectedId?: NodeId | null
  onSelect: (id: NodeId) => void
  onOpenInNewTab?: (id: NodeId) => void
  tree?: TreeNode | null
  onToggle?: (id: NodeId, expanded: boolean) => void
  onRename?: (id: NodeId, name: string) => void
  onDelete?: (id: NodeId) => void
  onDuplicate?: (id: NodeId) => Promise<NodeId | null> | NodeId | null
  onDownload?: (ids: NodeId[], format: NoteExportFormat) => void
  onImportFiles?: (files: NoteImportItem[], parentId: NodeId) => void
  onMoveTo?: (ids: NodeId[]) => void
  onCreate?: (parentId: NodeId, isFolder: boolean) => Promise<NodeId | null> | NodeId | null
  onMove?: (id: NodeId, parentId: NodeId) => void
  allowCreate?: boolean
  allowMove?: boolean
  sortOrder?: FileTreeSortOrder
  notePresence?: NotePresenceMap
  unreadNoteIds?: Set<NodeId>
}

export type FileTreeHostHandle = FileTreeHandle

export const FileTreeHost = forwardRef<FileTreeHandle, FileTreeHostProps>(function FileTreeHost(
  {
    tree,
    selectedId,
    onSelect,
    onOpenInNewTab,
    onToggle,
    onRename,
    onDelete,
    onDuplicate,
    onDownload,
    onImportFiles,
    onMoveTo,
    onCreate,
    onMove,
    allowCreate = true,
    allowMove = true,
    sortOrder,
    notePresence,
    unreadNoteIds,
  },
  ref,
) {
  const { currentNotebook } = useNotebooks();
  const activeRoot = tree ?? currentNotebook?.root ?? null;

  if (!activeRoot) {
    return <div className="p-2 opacity-70 text-sm">Create a notebook to get started.</div>;
  }

  const syntheticRoot: HiddenRoot = {
    ...activeRoot,
    hiddenRoot: true,
  };

  return (
    <FileTree
      ref={ref}
      root={syntheticRoot}
      roots={syntheticRoot.children ?? []}
      onCreate={onCreate ?? (async () => null)}
      onDelete={onDelete ?? (() => {})}
      onDuplicate={onDuplicate}
      onDownload={onDownload}
      onImportFiles={onImportFiles}
      onMoveTo={onMoveTo}
      onRename={onRename ?? (() => {})}
      onToggle={onToggle ?? (() => {})}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpenInNewTab={onOpenInNewTab}
      onMove={onMove}
      allowCreate={allowCreate}
      allowMove={allowMove}
      sortOrder={sortOrder}
      notePresence={notePresence}
      unreadNoteIds={unreadNoteIds}
    />
  );
})
