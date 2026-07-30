// =============================
// FileNode.tsx — a single row (no inline create/delete buttons)
// =============================
import type { DragEvent, MouseEvent } from "react"
import { RiImageLine } from "@remixicon/react"
import { type TreeNode, type NodeId } from "./tree"
import { EditableText } from "./editable-text"
import type { NotePresenceUser } from "@/hooks/use-note-presence"

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/)
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

function NotePresenceAvatars({ users }: { users: NotePresenceUser[] }) {
  if (users.length === 0) return null
  const visible = users.slice(0, 3)
  return (
    <span className="note-presence-avatars" aria-hidden>
      {visible.map((u, i) => (
        <span
          key={i}
          className="note-presence-avatar"
          style={{
            backgroundColor: u.color ?? "var(--tt-brand-color-300)",
            zIndex: visible.length - i,
          }}
          title={u.name}
        >
          {getInitials(u.name)}
        </span>
      ))}
    </span>
  )
}

export type FileNodeProps = {
  node: TreeNode
  depth: number
  selectedId?: NodeId | null
  multiSelectedIds?: Set<NodeId>
  focusedId?: NodeId | null
  isCut?: boolean
  onToggle: (id: NodeId, expanded: boolean) => void
  onCreate: (parentId: NodeId, isFolder: boolean) => void
  onDelete: (id: NodeId) => void
  onRename: (id: NodeId, name: string) => void
  onSelect: (id: NodeId, event?: MouseEvent) => void
  onDoubleClick?: (id: NodeId) => void
  onOpenInNewTab?: (id: NodeId) => void
  onContextMenu: (event: MouseEvent, node: TreeNode) => void
  renameRequest?: number
  onRenameEnd?: () => void
  draggable?: boolean
  isDragging?: boolean
  isDropTarget?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: (event: DragEvent<HTMLElement>) => void
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  viewingUsers?: NotePresenceUser[]
  isUnread?: boolean
}

export function FileNode({
  node,
  depth,
  selectedId,
  multiSelectedIds,
  focusedId,
  isCut = false,
  onToggle,
  onRename,
  onSelect,
  onDoubleClick,
  onOpenInNewTab,
  onContextMenu,
  renameRequest,
  onRenameEnd,
  draggable = false,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  viewingUsers,
  isUnread = false,
}: FileNodeProps) {
  const isSelected = selectedId === node.id || Boolean(multiSelectedIds?.has(node.id))
  const isFocused = focusedId === node.id
  const rowStyle = { ['--depth' as any]: depth } as React.CSSProperties
  const dragClassName = `${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`

  if (node.isFolder) {
    return (
      <div className="content-explorer-container" >
        <div
          className={`tree-row folder${dragClassName}`}
          data-depth={depth}
          style={rowStyle}
          onClick={() => onToggle(node.id, !node.expanded)}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onContextMenu(event, node)
          }}
        >
          <span className={`chevron ${node.expanded ? "bottom" : "right"}`}></span>
          <EditableText
            className="browser-editable-text"
            value={node.name}
            onCommit={(v) => onRename(node.id, v)}
            editRequest={renameRequest}
            onEditEnd={(_committed) => onRenameEnd?.()}
          />
        </div>
      </div>
    )
  }

  return (
    <span
      className={`tree-row file${isSelected ? " selected" : ""}${isFocused ? " is-focused" : ""}${isCut ? " is-cut" : ""}${isUnread ? " is-unread" : ""}${dragClassName}`}
      data-depth={depth}
      style={rowStyle}
      draggable={draggable}
      aria-grabbed={draggable ? isDragging : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={(event) => onSelect(node.id, event)}
      onDoubleClick={() => onDoubleClick?.(node.id)}
      onMouseDown={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        onOpenInNewTab?.(node.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onContextMenu(event, node)
      }}
    >
      <EditableText
        className="browser-editable-text"
        value={node.name}
        onCommit={(v) => onRename(node.id, v)}
        editRequest={renameRequest}
        onEditEnd={(_committed) => onRenameEnd?.()}
        tabbable={false}
      />
      {isUnread && <span className="note-unread-indicator" title="New content" aria-hidden />}
      <NotePresenceAvatars users={viewingUsers ?? []} />
      <span className="file-icon-slot" aria-hidden={!node.assetId}>
        {node.assetId ? <RiImageLine className="file-icon" aria-label="Image asset" /> : null}
      </span>
    </span>
  )
}
