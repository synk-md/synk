import * as React from "react"
import { createPortal } from "react-dom"
import { RiAddLine, RiImageLine } from "@remixicon/react"

import { CloseIcon } from "@/components/tiptap-icons/close-icon"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import {
  MenuSurface,
  type MenuItem,
} from "@/components/custom-ui/context-menu"

import "./note-tab-bar.scss"

type NoteTabBarProps = {
  notebookId: string
  activeNoteId?: string | null
  tree: TreeNode
  onSelectNote: (noteId: string) => void
  onCloseLastNote: () => void
  onNewTab?: () => void
  /** Ids of currently open virtual "New tab" pills, in order. */
  newTabIds?: string[]
  /** Which "New tab" pill (if any) is the currently active one. */
  activeNewTabId?: string | null
  onSelectNewTab?: (id: string) => void
  onCloseNewTab?: (id: string) => void
}

export type NoteTabBarHandle = {
  openNote: (noteId: string, mode: "replace" | "append") => void
}

type TabContextMenu = {
  noteId: string
  x: number
  y: number
}

type TabMenuContext = {
  noteId: string
}

const STORAGE_PREFIX = "synk:open-note-tabs:v1:"

function collectTabNodes(node: TreeNode, nodes = new Map<string, TreeNode>()) {
  if (!node.isFolder && typeof node.id === "string") {
    nodes.set(node.id, node)
  }

  for (const child of node.children ?? []) {
    collectTabNodes(child, nodes)
  }

  return nodes
}

function readStoredTabs(notebookId: string) {
  try {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${notebookId}`)
    const parsed = stored ? JSON.parse(stored) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

function NoteTabBarComponent(
  {
    notebookId,
    activeNoteId,
    tree,
    onSelectNote,
    onCloseLastNote,
    onNewTab,
    newTabIds,
    activeNewTabId,
    onSelectNewTab,
    onCloseNewTab,
  }: NoteTabBarProps,
  ref: React.ForwardedRef<NoteTabBarHandle>,
) {
  const tabNodesById = React.useMemo(() => collectTabNodes(tree), [tree])
  const [openNoteIds, setOpenNoteIds] = React.useState<string[]>(() =>
    readStoredTabs(notebookId),
  )
  const [draggedNoteId, setDraggedNoteId] = React.useState<string | null>(null)
  const [contextMenu, setContextMenu] = React.useState<TabContextMenu | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null)
  const tabRefs = React.useRef(new Map<string, HTMLDivElement>())

  React.useImperativeHandle(
    ref,
    () => ({
      openNote(noteId, mode) {
        if (!tabNodesById.has(noteId)) return

        setOpenNoteIds((current) => {
          if (current.includes(noteId)) return current
          if (mode === "append" || !activeNoteId) return [...current, noteId]

          const activeIndex = current.indexOf(activeNoteId)
          if (activeIndex === -1) return [...current, noteId]

          const next = [...current]
          next[activeIndex] = noteId
          return next
        })
      },
    }),
    [activeNoteId, tabNodesById],
  )

  React.useEffect(() => {
    setOpenNoteIds((current) => {
      const next = current.filter((id) => tabNodesById.has(id))

      if (
        activeNoteId &&
        tabNodesById.has(activeNoteId) &&
        !tabNodesById.get(activeNoteId)?.assetId &&
        !next.includes(activeNoteId)
      ) {
        next.push(activeNoteId)
      }

      if (
        next.length === current.length &&
        next.every((id, index) => id === current[index])
      ) {
        return current
      }

      return next
    })
  }, [activeNoteId, tabNodesById])

  React.useEffect(() => {
    try {
      localStorage.setItem(
        `${STORAGE_PREFIX}${notebookId}`,
        JSON.stringify(openNoteIds),
      )
    } catch {
      // Tabs still work for this session when storage is unavailable.
    }
  }, [notebookId, openNoteIds])

  const scrollActiveTabIntoView = React.useCallback((
    behavior: ScrollBehavior = "smooth",
  ) => {
    const targetKey = activeNewTabId ?? activeNoteId
    if (!targetKey) return

    const list = listRef.current
    const activeTab = tabRefs.current.get(targetKey)
    const scroller = list?.parentElement
    if (!activeTab || !scroller) return

    const tabRect = activeTab.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    const leftOverflow = tabRect.left - scrollerRect.left
    const rightOverflow = tabRect.right - scrollerRect.right

    if (leftOverflow < 0) {
      scroller.scrollBy({ left: leftOverflow, behavior })
    } else if (rightOverflow > 0) {
      scroller.scrollBy({ left: rightOverflow, behavior })
    }
  }, [activeNoteId, activeNewTabId])

  React.useEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      scrollActiveTabIntoView()
    })

    return () => cancelAnimationFrame(animationFrame)
  }, [openNoteIds, scrollActiveTabIntoView])

  React.useEffect(() => {
    const scroller = listRef.current?.parentElement
    if (!scroller) return

    let animationFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        scrollActiveTabIntoView("auto")
      })
    })

    observer.observe(scroller)

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [scrollActiveTabIntoView])

  React.useEffect(() => {
    if (!contextMenu) return

    const closeMenu = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null)
    }
    const closeOnViewportChange = () => setContextMenu(null)

    document.addEventListener("mousedown", closeMenu)
    document.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", closeOnViewportChange)
    window.addEventListener("scroll", closeOnViewportChange, true)

    return () => {
      document.removeEventListener("mousedown", closeMenu)
      document.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", closeOnViewportChange)
      window.removeEventListener("scroll", closeOnViewportChange, true)
    }
  }, [contextMenu])

  const closeTabs = React.useCallback(
    (noteIds: string[], preferredNextNoteId?: string) => {
      const notesToClose = new Set(noteIds)
      const remaining = openNoteIds.filter((id) => !notesToClose.has(id))
      setOpenNoteIds(remaining)

      if (!activeNoteId || !notesToClose.has(activeNoteId)) return

      if (remaining.length === 0) {
        onCloseLastNote()
        return
      }

      const activeIndex = openNoteIds.indexOf(activeNoteId)
      const nextNoteId = preferredNextNoteId &&
        remaining.includes(preferredNextNoteId)
        ? preferredNextNoteId
        : remaining[Math.min(activeIndex, remaining.length - 1)]

      if (nextNoteId) {
        onSelectNote(nextNoteId)
      }
    },
    [activeNoteId, onCloseLastNote, onSelectNote, openNoteIds],
  )

  const closeTab = React.useCallback(
    (noteId: string) => closeTabs([noteId]),
    [closeTabs],
  )

  const tabMenuItems = React.useMemo<MenuItem<TabMenuContext>[]>(() => [
    {
      id: "close",
      label: "Close",
      run: ({ noteId }) => closeTabs([noteId]),
    },
    {
      id: "close-others",
      label: "Close others",
      isEnabled: () => openNoteIds.length > 1,
      run: ({ noteId }) => {
        closeTabs(
          openNoteIds.filter((id) => id !== noteId),
          noteId,
        )
      },
    },
    {
      id: "close-after",
      label: "Close tabs after",
      isEnabled: ({ noteId }) => {
        const tabIndex = openNoteIds.indexOf(noteId)
        return tabIndex !== -1 && tabIndex < openNoteIds.length - 1
      },
      run: ({ noteId }) => {
        const tabIndex = openNoteIds.indexOf(noteId)
        if (tabIndex === -1) return
        closeTabs(openNoteIds.slice(tabIndex + 1), noteId)
      },
    },
    {
      id: "close-all",
      label: "Close all",
      separatorBefore: true,
      run: () => closeTabs(openNoteIds),
    },
  ], [closeTabs, openNoteIds])

  const moveDraggedTab = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>, overNoteId: string) => {
      event.preventDefault()
      if (!draggedNoteId || draggedNoteId === overNoteId) return

      const bounds = event.currentTarget.getBoundingClientRect()
      const insertAfter = event.clientX > bounds.left + bounds.width / 2

      setOpenNoteIds((current) => {
        const withoutDragged = current.filter((id) => id !== draggedNoteId)
        const overIndex = withoutDragged.indexOf(overNoteId)
        if (overIndex === -1) return current

        const insertIndex = overIndex + (insertAfter ? 1 : 0)
        const next = [...withoutDragged]
        next.splice(insertIndex, 0, draggedNoteId)

        return next.every((id, index) => id === current[index])
          ? current
          : next
      })
    },
    [draggedNoteId],
  )

  const tabs = openNoteIds.flatMap((id) => {
    const node = tabNodesById.get(id)
    return node
      ? [{ id, title: node.name || "Untitled", isImage: Boolean(node.assetId) }]
      : []
  })

  return (
    <>
      <div
        ref={listRef}
        className="note-tab-list"
        role="tablist"
        aria-label="Open notes and images"
        onWheel={(event) => {
          const scroller = event.currentTarget.parentElement
          if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return

          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY

          if (delta === 0) return
          event.preventDefault()
          scroller.scrollLeft += delta
        }}
      >
        {tabs.map((tab) => {
          const isActive = !activeNewTabId && tab.id === activeNoteId
          const isDragging = tab.id === draggedNoteId

          return (
            <div
              key={tab.id}
              ref={(element) => {
                if (element) {
                  tabRefs.current.set(tab.id, element)
                } else {
                  tabRefs.current.delete(tab.id)
                }
              }}
              className={`note-tab${isActive ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title={tab.title}
              draggable
              data-tt-native-context-menu
              onClick={() => onSelectNote(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) closeTab(tab.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()

                const menuWidth = 216
                const menuHeight = 188
                setContextMenu({
                  noteId: tab.id,
                  x: Math.max(
                    0,
                    Math.min(event.clientX, window.innerWidth - menuWidth),
                  ),
                  y: Math.max(
                    0,
                    Math.min(event.clientY, window.innerHeight - menuHeight),
                  ),
                })
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onSelectNote(tab.id)
                }
              }}
              onDragStart={(event) => {
                setDraggedNoteId(tab.id)
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", tab.id)
              }}
              onDragOver={(event) => moveDraggedTab(event, tab.id)}
              onDrop={(event) => event.preventDefault()}
              onDragEnd={() => setDraggedNoteId(null)}
            >
              {tab.isImage && <RiImageLine className="note-tab-icon" aria-hidden="true" />}
              <span className="note-tab-title">{tab.title}</span>
              <button
                className="note-tab-close"
                type="button"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
          )
        })}

        {newTabIds?.map((id) => {
          const isActive = id === activeNewTabId

          return (
            <div
              key={id}
              ref={(element) => {
                if (element) {
                  tabRefs.current.set(id, element)
                } else {
                  tabRefs.current.delete(id)
                }
              }}
              className={`note-tab${isActive ? " is-active" : ""}`}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title="New tab"
              onClick={() => onSelectNewTab?.(id)}
              onAuxClick={(event) => {
                if (event.button === 1) onCloseNewTab?.(id)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onSelectNewTab?.(id)
                }
              }}
            >
              <span className="note-tab-title">New tab</span>
              <button
                className="note-tab-close"
                type="button"
                aria-label="Close New tab"
                title="Close New tab"
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseNewTab?.(id)
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
          )
        })}

        {onNewTab && (
          <button
            className="note-tab-new"
            type="button"
            aria-label="New tab"
            title="New tab"
            onClick={onNewTab}
          >
            <RiAddLine aria-hidden="true" />
          </button>
        )}
      </div>

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="tt-context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            transform: "translate(6px, 6px)",
            zIndex: 9999,
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <MenuSurface
            spec={tabMenuItems}
            ctx={{ noteId: contextMenu.noteId }}
            onClose={() => setContextMenu(null)}
            cardStyle={{ minWidth: 208 }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}

export const NoteTabBar = React.forwardRef(NoteTabBarComponent)
NoteTabBar.displayName = "NoteTabBar"
