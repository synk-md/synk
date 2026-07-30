
import React, { useCallback } from "react"
import { MenuSurface, type MenuSpec, type MenuItem } from "@/components/custom-ui/context-menu"
import { findNode, isNoteNode, type TreeNode, type NodeId, type FileTreeSortOrder } from "./tree"
import { FileNode } from "./file-node"
import type { NoteExportFormat } from "@/lib/note-export"
import { isImportableNoteFile, type NoteImportItem } from "@/lib/note-import"
import type { NotePresenceMap } from "@/hooks/use-note-presence"

import { RiEditLine } from '@remixicon/react'
import { RiDeleteBinLine } from '@remixicon/react'
import { RiFolderAddLine, RiStickyNoteAddLine, RiFileCopyLine, RiExternalLinkLine } from "@remixicon/react"
import { RiDownloadLine, RiMarkdownLine, RiBracesLine, RiFileTextLine } from "@remixicon/react"
import { RiFolderTransferLine } from "@remixicon/react"

type HiddenRoot = TreeNode & { hiddenRoot?: boolean }

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

function compareByName(a: TreeNode, b: TreeNode) {
  return nameCollator.compare(a.name, b.name)
}

function compareByTimestamp(
  a: TreeNode,
  b: TreeNode,
  key: "createdAt" | "modifiedAt",
  direction: "asc" | "desc",
) {
  const aTime = a[key] ?? 0
  const bTime = b[key] ?? 0
  const result = direction === "asc" ? aTime - bTime : bTime - aTime
  return result || compareByName(a, b)
}

function childrenBySortOrder(node: TreeNode, sortOrder: FileTreeSortOrder) {
  return [...(node.children ?? [])].sort((a, b) => {
    switch (sortOrder) {
      case "name-desc":
        return compareByName(b, a)
      case "modified-desc":
        return compareByTimestamp(a, b, "modifiedAt", "desc")
      case "modified-asc":
        return compareByTimestamp(a, b, "modifiedAt", "asc")
      case "created-desc":
        return compareByTimestamp(a, b, "createdAt", "desc")
      case "created-asc":
        return compareByTimestamp(a, b, "createdAt", "asc")
      case "name-asc":
      default:
        return compareByName(a, b)
    }
  })
}

export type FileTreeProps = {
  root?: TreeNode
  roots: TreeNode[]
  selectedId?: NodeId | null
  onToggle: (id: NodeId, expanded: boolean) => void
  onCreate: (parentId: NodeId, isFolder: boolean) => Promise<NodeId | null> | NodeId | null
  onDelete: (id: NodeId) => void
  onDuplicate?: (id: NodeId) => Promise<NodeId | null> | NodeId | null
  onDownload?: (ids: NodeId[], format: NoteExportFormat) => void
  onImportFiles?: (files: NoteImportItem[], parentId: NodeId) => void
  onMoveTo?: (ids: NodeId[]) => void
  onRename: (id: NodeId, name: string) => void
  onMove?: (id: NodeId, parentId: NodeId) => void
  onSelect: (id: NodeId) => void
  onOpenInNewTab?: (id: NodeId) => void
  allowCreate?: boolean
  allowMove?: boolean
  sortOrder?: FileTreeSortOrder
  notePresence?: NotePresenceMap
  unreadNoteIds?: Set<NodeId>
}

type FileTreeMenuContext = {
  node: TreeNode
  selection: NodeId[]
  isRootMenu?: boolean
}

function downloadFormatItems(
  ids: NodeId[],
  onDownload: (ids: NodeId[], format: NoteExportFormat) => void,
): MenuItem<FileTreeMenuContext>[] {
  return [
    {
      id: "download-markdown",
      label: "Markdown (.md)",
      icon: <RiMarkdownLine className="tiptap-button-icon" />,
      run: () => onDownload(ids, "markdown"),
    },
    {
      id: "download-json",
      label: "JSON (.json)",
      icon: <RiBracesLine className="tiptap-button-icon" />,
      run: () => onDownload(ids, "json"),
    },
    {
      id: "download-text",
      label: "Plain Text (.txt)",
      icon: <RiFileTextLine className="tiptap-button-icon" />,
      run: () => onDownload(ids, "text"),
    },
  ]
}

function hasFileItems(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
    || Array.from(dataTransfer.types ?? []).includes("Files")
}

type SynkFileSystemEntry = {
  name: string
  fullPath: string
  isFile: boolean
  isDirectory: boolean
}

type SynkFileSystemFileEntry = SynkFileSystemEntry & {
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void
}

type SynkFileSystemDirectoryEntry = SynkFileSystemEntry & {
  createReader: () => {
    readEntries: (
      successCallback: (entries: SynkFileSystemEntry[]) => void,
      errorCallback?: (error: DOMException) => void,
    ) => void
  }
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => SynkFileSystemEntry | null
}

function fileFromEntry(entry: SynkFileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function readDirectoryEntries(entry: SynkFileSystemDirectoryEntry) {
  const reader = entry.createReader()
  const entries: SynkFileSystemEntry[] = []

  return new Promise<SynkFileSystemEntry[]>((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries)
          return
        }

        entries.push(...batch)
        readBatch()
      }, reject)
    }

    readBatch()
  })
}

async function importItemsFromEntry(entry: SynkFileSystemEntry, parentPath = ""): Promise<NoteImportItem[]> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await fileFromEntry(entry as SynkFileSystemFileEntry)
    return isImportableNoteFile(file) ? [{ file, path }] : []
  }

  if (!entry.isDirectory) return []

  const children = await readDirectoryEntries(entry as SynkFileSystemDirectoryEntry)
  const nested = await Promise.all(children.map((child) => importItemsFromEntry(child, path)))
  return nested.flat()
}

async function noteImportItemsFromDataTransfer(dataTransfer: DataTransfer): Promise<NoteImportItem[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => {
      const getAsEntry = (item as DataTransferItemWithEntry).webkitGetAsEntry
      return getAsEntry ? (getAsEntry.call(item) as SynkFileSystemEntry | null) : null
    })
    .filter((entry): entry is SynkFileSystemEntry => entry !== null)

  if (entries.length) {
    const nested = await Promise.all(entries.map((entry) => importItemsFromEntry(entry)))
    return nested.flat()
  }

  return Array.from(dataTransfer.files)
    .filter(isImportableNoteFile)
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
}

export type FileTreeHandle = {
  requestRename: (id: NodeId, selectOnRename?: boolean) => void
}

export const FileTree = React.forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  props,
  ref,
) {
  const [contextMenu, setContextMenu] = React.useState<{ node: TreeNode; x: number; y: number; selection: NodeId[] } | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [renameRequest, setRenameRequest] = React.useState<{ id: NodeId; token: number } | null>(null)
  const [draggedNodeIds, setDraggedNodeIds] = React.useState<Set<NodeId>>(new Set())
  const [dropTargetId, setDropTargetId] = React.useState<NodeId>(null)
  const draggedNodeIdsRef = React.useRef<NodeId[]>([])
  const [multiSelectedIds, setMultiSelectedIds] = React.useState<Set<NodeId>>(new Set())
  const [focusedNoteId, setFocusedNoteId] = React.useState<NodeId | null>(null)
  const [clipboard, setClipboard] = React.useState<{ ids: NodeId[]; mode: "copy" | "cut" } | null>(null)
  const lastClickedIdRef = React.useRef<NodeId | null>(null)
  const visibleFileIdsRef = React.useRef<NodeId[]>([])

  // Deletes are spaced across ticks so the tree/notebook persistence state
  // (which round-trips through context on each delete) settles before the
  // next mutation — batching them synchronously crashes React.
  const deleteMany = React.useCallback(
    async (ids: NodeId[]) => {
      for (const id of ids) {
        props.onDelete(id)
        if (ids.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    },
    [props.onDelete],
  )

  const syntheticRoot: HiddenRoot = props.root
    ? { ...props.root, hiddenRoot: true }
    : { id: "__root__", name: "", isFolder: true, expanded: true, children: props.roots, hiddenRoot: true }

  const closeContextMenu = React.useCallback(() => setContextMenu(null), [])

  const requestRename = React.useCallback((id: NodeId, selectOnRename: boolean = false) => {
    if (selectOnRename) {
      props.onSelect(id)
    }

    setRenameRequest({ id, token: Date.now() })
  }, [props.onSelect])

  React.useImperativeHandle(ref, () => ({ requestRename }), [requestRename])

  const handleToggle = React.useCallback(
    (id: NodeId, expanded: boolean) => {
      setMultiSelectedIds(new Set())
      setFocusedNoteId(null)
      props.onToggle(id, expanded)
    },
    [props.onToggle],
  )

  const handleNodeDoubleClick = React.useCallback((id: NodeId) => {
    setMultiSelectedIds(new Set())
    setFocusedNoteId(id)
  }, [])

  const handleNodeSelect = React.useCallback(
    (id: NodeId, event?: React.MouseEvent) => {
      const isToggle = Boolean(event?.metaKey || event?.ctrlKey)
      const isRange = Boolean(event?.shiftKey)

      setFocusedNoteId(null)

      if (isToggle) {
        setMultiSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) {
            next.delete(id)
          } else {
            if (next.size === 0 && props.selectedId && props.selectedId !== id) {
              next.add(props.selectedId)
            }
            next.add(id)
          }
          return next
        })
        lastClickedIdRef.current = id
        return
      }

      if (isRange && lastClickedIdRef.current) {
        const order = visibleFileIdsRef.current
        const fromIdx = order.indexOf(lastClickedIdRef.current)
        const toIdx = order.indexOf(id)
        if (fromIdx !== -1 && toIdx !== -1) {
          const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
          setMultiSelectedIds(new Set(order.slice(start, end + 1)))
          return
        }
      }

      setMultiSelectedIds(new Set())
      lastClickedIdRef.current = id
      props.onSelect(id)
    },
    [props.onSelect, props.selectedId],
  )

  const allowCreate = props.allowCreate !== false
  const allowMove = props.allowMove !== false && Boolean(props.onMove)
  const allowFileImport = allowCreate && Boolean(props.onImportFiles)
  const sortOrder = props.sortOrder ?? "name-asc"

  const menuSpec = React.useMemo<MenuSpec<FileTreeMenuContext>>(
    () => (ctx) => {
      const { node, selection, isRootMenu } = ctx
      const items: MenuItem<FileTreeMenuContext>[] = []

      if (!node.id) {
        return items
      }

      if (selection.length > 1) {
        if (props.onMoveTo) {
          items.push({
            id: "move-to",
            label: `Move ${selection.length} notes to…`,
            icon: <RiFolderTransferLine className="tiptap-button-icon" />,
            run: () => {
              props.onMoveTo!(selection)
            },
          })
        }
        if (props.onDownload) {
          items.push({
            id: "download",
            label: `Download ${selection.length} notes`,
            icon: <RiDownloadLine className="tiptap-button-icon" />,
            children: downloadFormatItems(selection, props.onDownload),
            separatorAfter: true,
          })
        }
        items.push({
          id: "delete",
          label: `Delete ${selection.length} notes`,
          icon: <RiDeleteBinLine className="tiptap-button-icon" />,
          dangerous: true,
          run: async () => {
            setMultiSelectedIds(new Set())
            await deleteMany(selection)
          },
        })
        return items
      }

      if (node.isFolder && allowCreate) {
        items.push(
          {
            id: "new-note",
            label: "New note",
            icon: <RiStickyNoteAddLine className="tiptap-button-icon" />,
            run: () => {
              void Promise.resolve(props.onCreate(node.id, false)).then((createdId) => {
                if (createdId) {
                  requestRename(createdId)
                }
              })
            },
          },
          {
            id: "new-folder",
            label: "New folder",
            icon: <RiFolderAddLine className="tiptap-button-icon" />,
            run: () => {
              void Promise.resolve(props.onCreate(node.id, true)).then((createdId) => {
                if (createdId) {
                  requestRename(createdId)
                }
              })
            },
            separatorAfter: !isRootMenu,
          },
        )
      }

      if (isRootMenu) {
        return items
      }

      if (isNoteNode(node) && props.onOpenInNewTab) {
        items.push({
          id: "open-in-new-tab",
          label: "Open in new tab",
          icon: <RiExternalLinkLine className="tiptap-button-icon" />,
          run: () => {
            props.onOpenInNewTab!(node.id)
          },
          separatorAfter: true,
        })
      }

      items.push({
        id: "rename",
        label: "Rename",
        icon: <RiEditLine className="tiptap-button-icon" />,
        run: () => {
          requestRename(node.id)
        },
      })

      if (isNoteNode(node) && props.onDuplicate) {
        items.push({
          id: "duplicate",
          label: "Make a copy",
          icon: <RiFileCopyLine className="tiptap-button-icon" />,
          run: () => {
            void Promise.resolve(props.onDuplicate!(node.id)).then((createdId) => {
              if (createdId) {
                requestRename(createdId)
              }
            })
          },
        })
      }

      if (isNoteNode(node) && props.onMoveTo) {
        items.push({
          id: "move-to",
          label: "Move to…",
          icon: <RiFolderTransferLine className="tiptap-button-icon" />,
          run: () => {
            props.onMoveTo!([node.id])
          },
        })
      }

      if (isNoteNode(node) && props.onDownload) {
        items.push({
          id: "download",
          label: "Download",
          icon: <RiDownloadLine className="tiptap-button-icon" />,
          children: downloadFormatItems([node.id], props.onDownload),
          separatorBefore: true,
        })
      }

      items.push({
        id: "delete",
        label: "Delete",
        icon: <RiDeleteBinLine className="tiptap-button-icon" />,
        dangerous: true,
        separatorBefore: true,
        run: () => {
          props.onDelete(node.id)
        },
      })

      return items
    },
    [props.onCreate, props.onDelete, props.onDuplicate, props.onDownload, props.onMoveTo, props.onOpenInNewTab, requestRename, allowCreate, deleteMany],
  )

  React.useEffect(() => {
    if (!contextMenu) return

    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return
      closeContextMenu()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu()
    }

    const handleScroll = () => closeContextMenu()

    document.addEventListener("mousedown", handleMouseDown)
    document.addEventListener("contextmenu", handleMouseDown)
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("scroll", handleScroll, true)

    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("contextmenu", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("scroll", handleScroll, true)
    }
  }, [contextMenu, closeContextMenu])

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNode) => {
      if (!node.id) return

      const isPartOfMultiSelection = !node.isFolder && multiSelectedIds.has(node.id) && multiSelectedIds.size > 1
      const selection = isPartOfMultiSelection ? Array.from(multiSelectedIds) : [node.id]

      const menuWidth = 220
      const menuHeight = selection.length > 1
        ? 60 + (props.onMoveTo ? 36 : 0) + (props.onDownload ? 36 : 0)
        : node.isFolder
          ? 210
          : (isNoteNode(node) && props.onDuplicate ? 176 : 140)
            + (isNoteNode(node) && props.onOpenInNewTab ? 36 : 0)
            + (isNoteNode(node) && props.onDownload ? 36 : 0)
            + (isNoteNode(node) && props.onMoveTo ? 36 : 0)
      const x = Math.min(event.clientX, window.innerWidth - menuWidth)
      const y = Math.min(event.clientY, window.innerHeight - menuHeight)

      setContextMenu({ node, x, y, selection })

      if (!node.isFolder && !isPartOfMultiSelection) {
        setMultiSelectedIds(new Set())
      }
      setFocusedNoteId(null)
    },
    [multiSelectedIds, props.onDuplicate, props.onOpenInNewTab, props.onDownload, props.onMoveTo],
  )

  const handleTreeContextMenu = React.useCallback(
    (event: React.MouseEvent) => {
      if (!allowCreate || !syntheticRoot.id) return

      event.preventDefault()
      event.stopPropagation()

      const menuWidth = 220
      const menuHeight = 104
      const x = Math.min(event.clientX, window.innerWidth - menuWidth)
      const y = Math.min(event.clientY, window.innerHeight - menuHeight)

      setMultiSelectedIds(new Set())
      setFocusedNoteId(null)
      setContextMenu({ node: syntheticRoot, x, y, selection: [] })
    },
    [allowCreate, syntheticRoot],
  )

  const handleRenameEnd = React.useCallback(() => {
    setRenameRequest(null)
  }, [])

  const clearDragState = React.useCallback(() => {
    draggedNodeIdsRef.current = []
    setDraggedNodeIds(new Set())
    setDropTargetId(null)
  }, [])

  const handleDragStart = React.useCallback(
    (event: React.DragEvent<HTMLElement>, node: TreeNode) => {
      if (!allowMove || node.isFolder || typeof node.id !== "string") {
        event.preventDefault()
        return
      }

      const isMultiDrag = multiSelectedIds.has(node.id) && multiSelectedIds.size > 1
      const ids = isMultiDrag ? Array.from(multiSelectedIds) : [node.id]

      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("application/x-synk-note-ids", JSON.stringify(ids))
      event.dataTransfer.setData("text/plain", node.id)
      // Lets the editor's image extension recognize an asset dropped from the
      // explorer and insert it directly, instead of treating the drop as an
      // in-tree move (which is all the data above is otherwise used for).
      if (node.assetId) {
        event.dataTransfer.setData(
          "application/x-synk-asset",
          JSON.stringify({ assetId: node.assetId, name: node.name }),
        )
      }
      draggedNodeIdsRef.current = ids
      setDraggedNodeIds(new Set(ids))
    },
    [allowMove, multiSelectedIds],
  )

  const handleDragOver = React.useCallback(
    (
      event: React.DragEvent<HTMLElement>,
      destinationParentId: NodeId,
      targetId: NodeId,
    ) => {
      if (!destinationParentId) return

      if (draggedNodeIdsRef.current.length) {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "move"
      } else if (allowFileImport && hasFileItems(event.dataTransfer)) {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "copy"
      } else {
        return
      }

      setDropTargetId(targetId)
    },
    [allowFileImport],
  )

  const handleDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLElement>, targetId: NodeId) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDropTargetId((current) => (current === targetId ? null : current))
    },
    [],
  )

  const moveMany = React.useCallback(
    async (ids: NodeId[], destinationParentId: NodeId) => {
      // Spaced across ticks for the same reason bulk delete is: the tree/notebook
      // persistence round-trips through context on each move, and batching the
      // mutations synchronously crashes React (render-phase setState conflict).
      for (const id of ids) {
        props.onMove?.(id, destinationParentId)
        if (ids.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    },
    [props.onMove],
  )

  // FileTree only ever receives the open note's id as `selectedId` (folders
  // aren't "selected", just toggled), so the closest stand-in for "the
  // selected folder" is the parent of whichever note is currently open.
  const resolvePasteTargetId = React.useCallback((): NodeId => {
    if (props.selectedId) {
      const { path } = findNode(syntheticRoot, props.selectedId)
      if (path.length) {
        const parent = path.slice(0, -1).reduce<HiddenRoot>(
          (n, idx) => n.children![idx] as HiddenRoot,
          syntheticRoot,
        )
        if (parent?.id) return parent.id
      }
    }
    return syntheticRoot.id
  }, [props.selectedId, syntheticRoot])

  const pasteClipboard = React.useCallback(async () => {
    if (!clipboard || !clipboard.ids.length) return
    const targetId = resolvePasteTargetId()
    if (!targetId) return

    if (clipboard.mode === "cut") {
      await moveMany(clipboard.ids, targetId)
      setClipboard(null)
      setMultiSelectedIds(new Set())
      setFocusedNoteId(null)
      return
    }

    if (!props.onDuplicate) return
    for (const id of clipboard.ids) {
      // Duplicate lands as a sibling of the source; only move it if the
      // paste target is actually a different folder.
      const { path: sourcePath } = findNode(syntheticRoot, id)
      const sourceParentId = sourcePath.length
        ? sourcePath.slice(0, -1).reduce<HiddenRoot>((n, idx) => n.children![idx] as HiddenRoot, syntheticRoot).id
        : syntheticRoot.id

      const newId = await Promise.resolve(props.onDuplicate(id))
      if (newId && targetId !== sourceParentId) {
        // Let the duplicate's own tree/persistence updates settle before
        // moving it — calling onMove in the same tick races React's
        // in-flight state from onDuplicate and crashes the editor.
        await new Promise((resolve) => setTimeout(resolve, 0))
        props.onMove?.(newId, targetId)
      }
      if (clipboard.ids.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }, [clipboard, resolvePasteTargetId, moveMany, props.onDuplicate, props.onMove, syntheticRoot])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isDelete = event.key === "Delete" || event.key === "Backspace"
      const isMeta = event.metaKey || event.ctrlKey
      const isCopy = isMeta && (event.key === "c" || event.key === "C")
      const isCut = isMeta && (event.key === "x" || event.key === "X")
      const isPaste = isMeta && (event.key === "v" || event.key === "V")
      const isEscape = event.key === "Escape"
      if (!isDelete && !isCopy && !isCut && !isPaste && !isEscape) return
      if (contextMenu) return

      // Don't hijack the key while the user is typing somewhere else
      // (renaming a node, editing note content, etc.).
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return
      }

      if (isEscape) {
        if (clipboard) setClipboard(null)
        return
      }

      const focusedIds = multiSelectedIds.size > 0 ? Array.from(multiSelectedIds) : focusedNoteId ? [focusedNoteId] : []

      if (isPaste) {
        if (!clipboard) return
        event.preventDefault()
        void pasteClipboard()
        return
      }

      if (isCopy || isCut) {
        if (!focusedIds.length) return
        event.preventDefault()
        setClipboard({ ids: focusedIds, mode: isCut ? "cut" : "copy" })
        return
      }

      if (multiSelectedIds.size > 0) {
        event.preventDefault()
        const ids = Array.from(multiSelectedIds)
        setMultiSelectedIds(new Set())
        void deleteMany(ids)
        return
      }

      if (focusedNoteId) {
        event.preventDefault()
        const id = focusedNoteId
        setFocusedNoteId(null)
        void deleteMany([id])
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [contextMenu, multiSelectedIds, focusedNoteId, deleteMany, clipboard, pasteClipboard])

  const handleDrop = React.useCallback(
    async (event: React.DragEvent<HTMLElement>, destinationParentId: NodeId) => {
      if (!destinationParentId) return

      event.preventDefault()
      event.stopPropagation()

      if (allowFileImport && hasFileItems(event.dataTransfer)) {
        const files = await noteImportItemsFromDataTransfer(event.dataTransfer)
        if (files.length) {
          props.onImportFiles?.(files, destinationParentId)
        }
        clearDragState()
        return
      }

      let draggedIds: NodeId[] = []
      const raw = event.dataTransfer.getData("application/x-synk-note-ids")
      if (raw) {
        try {
          draggedIds = JSON.parse(raw)
        } catch {
          draggedIds = []
        }
      }
      if (!draggedIds.length) {
        const fallback = event.dataTransfer.getData("text/plain") || draggedNodeIdsRef.current[0]
        draggedIds = fallback ? [fallback] : draggedNodeIdsRef.current
      }

      if (draggedIds.length) {
        void moveMany(draggedIds, destinationParentId)
      }

      clearDragState()
    },
    [allowFileImport, clearDragState, moveMany, props.onImportFiles],
  )

  const renderNode = useCallback(
    (node: HiddenRoot, depth = 0, parentId: NodeId = null): React.ReactNode => {
      if (node.hiddenRoot) {
        // keys applied here for root-level children
        return childrenBySortOrder(node, sortOrder).map((c) => (
          <React.Fragment key={c.id}>{renderNode(c as HiddenRoot, depth, node.id)}</React.Fragment>
        ))
      }

      const requestToken = renameRequest?.id === node.id ? renameRequest.token : undefined
      const destinationParentId = node.isFolder ? node.id : parentId

      if (!node.isFolder) {
        visibleFileIdsRef.current.push(node.id)
      }

      return (
        <div
          key={node.id}
          className="file-tree-node"
          style={
            (depth === 0
              ? ({ ['--subtree-offset' as any]: 'var(--root-indent)' } as React.CSSProperties)
              : undefined)
          }
        >
          <FileNode
            node={node}
            depth={depth}
            selectedId={props.selectedId}
            multiSelectedIds={multiSelectedIds}
            focusedId={focusedNoteId}
            isCut={clipboard?.mode === "cut" && clipboard.ids.includes(node.id)}
            onToggle={handleToggle}
            onCreate={props.onCreate}
            onDelete={props.onDelete}
            onRename={props.onRename}
            onSelect={handleNodeSelect}
            onDoubleClick={handleNodeDoubleClick}
            onOpenInNewTab={props.onOpenInNewTab}
            onContextMenu={handleNodeContextMenu}
            renameRequest={requestToken}
            onRenameEnd={handleRenameEnd}
            draggable={allowMove && !node.isFolder}
            isDragging={draggedNodeIds.has(node.id)}
            isDropTarget={dropTargetId === node.id}
            onDragStart={(event) => handleDragStart(event, node)}
            onDragEnd={clearDragState}
            onDragOver={(event) => handleDragOver(event, destinationParentId, node.id)}
            onDragLeave={(event) => handleDragLeave(event, node.id)}
            onDrop={(event) => handleDrop(event, destinationParentId)}
            viewingUsers={node.id != null ? props.notePresence?.get(node.id) : undefined}
            isUnread={props.unreadNoteIds?.has(node.id) ?? false}
          />
          {node.isFolder &&
            node.expanded && (
              <div
                className={`folder-children${dropTargetId === node.id ? " is-drop-target" : ""}`}
                style={{ ['--depth' as any]: depth } as React.CSSProperties}
                onDragOver={(event) => handleDragOver(event, node.id, node.id)}
                onDragLeave={(event) => handleDragLeave(event, node.id)}
                onDrop={(event) => handleDrop(event, node.id)}
              >
                {childrenBySortOrder(node, sortOrder).map((c) => (
                  // keys applied here for every folder’s children
                  <React.Fragment key={c.id}>{renderNode(c as HiddenRoot, depth + 1, node.id)}</React.Fragment>
                ))}
              </div>
            )}
        </div>
      )
    },
    [
      props.selectedId,
      multiSelectedIds,
      focusedNoteId,
      clipboard,
      handleToggle,
      props.onCreate,
      props.onDelete,
      props.onRename,
      props.onMove,
      props.onImportFiles,
      sortOrder,
      handleNodeSelect,
      handleNodeDoubleClick,
      props.onOpenInNewTab,
      allowMove,
      draggedNodeIds,
      dropTargetId,
      clearDragState,
      handleDragStart,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handleNodeContextMenu,
      renameRequest,
      handleRenameEnd,
      props.notePresence,
      props.unreadNoteIds,
    ]
  )

  visibleFileIdsRef.current = []

  return (
    <div
      className={`file-tree${dropTargetId === syntheticRoot.id ? " is-drop-target" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setMultiSelectedIds(new Set())
          setFocusedNoteId(null)
        }
      }}
      onContextMenu={handleTreeContextMenu}
      onDragOver={(event) => handleDragOver(event, syntheticRoot.id, syntheticRoot.id)}
      onDragLeave={(event) => handleDragLeave(event, syntheticRoot.id)}
      onDrop={(event) => handleDrop(event, syntheticRoot.id)}
    >
      {renderNode(syntheticRoot)}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            transform: "translate(6px, 6px)",
            zIndex: 30,
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <MenuSurface
            spec={menuSpec}
            ctx={{
              node: contextMenu.node,
              selection: contextMenu.selection,
              isRootMenu: Boolean(contextMenu.node.hiddenRoot),
            }}
            onClose={closeContextMenu}
            cardStyle={{ minWidth: 208 }}
          />
        </div>
      )}
    </div>
  )
})
