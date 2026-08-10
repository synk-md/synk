import * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { computePosition, flip, shift, offset } from "@floating-ui/dom"
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion"

import type { NoteEntry } from "@/components/custom-ui/file-browser/tree"
// Reuses the note quick-switcher's card chrome and `qp-*` item classes
// (qp-list/qp-item/qp-item-name/qp-item-path) so this looks like the same
// picker, just anchored at the caret instead of centered as a modal.
import "@/components/custom-ui/quick-pick/quick-pick.scss"

type NoteLinkSuggestionListProps = SuggestionProps<NoteEntry>

export interface NoteLinkSuggestionListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

const NoteLinkSuggestionList = React.forwardRef<NoteLinkSuggestionListHandle, NoteLinkSuggestionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = React.useState(0)

    React.useEffect(() => setSelectedIndex(0), [items])

    const selectItem = React.useCallback(
      (index: number) => {
        const item = items[index]
        if (item) command(item)
      },
      [items, command],
    )

    React.useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false

        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length)
          return true
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % items.length)
          return true
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex)
          return true
        }
        return false
      },
    }))

    return (
      <div className="note-link-suggestion-card">
        <div className="qp-list" role="listbox">
          {items.length === 0 ? (
            <div className="qp-empty">No notes found</div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`qp-item${index === selectedIndex ? " is-selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => selectItem(index)}
              >
                <span className="qp-item-name">{item.name}</span>
                {item.path.length > 0 && (
                  <span className="qp-item-path">{item.path.map((folder) => `${folder}/`)}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    )
  },
)

function updatePosition(clientRect: (() => DOMRect | null) | null | undefined, element: HTMLElement) {
  if (!clientRect) return
  const rect = clientRect()
  if (!rect) return

  const virtualElement = { getBoundingClientRect: () => rect }
  void computePosition(virtualElement, element, {
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  }).then(({ x, y, strategy }) => {
    element.style.position = strategy
    element.style.left = `${x}px`
    element.style.top = `${y}px`
  })
}

// Imperative `render()` factory for `@tiptap/suggestion` — mounts a React
// root into a floating, caret-anchored container appended to <body>,
// positioned with the same floating-ui primitives used elsewhere in the app.
export function renderNoteLinkSuggestion() {
  let element: HTMLDivElement | null = null
  let root: Root | null = null
  const listRef = React.createRef<NoteLinkSuggestionListHandle>()

  return {
    onStart: (props: NoteLinkSuggestionListProps) => {
      element = document.createElement("div")
      element.className = "note-link-suggestion-popup"
      document.body.appendChild(element)
      root = createRoot(element)
      root.render(<NoteLinkSuggestionList ref={listRef} {...props} />)
      updatePosition(props.clientRect, element)
    },

    onUpdate: (props: NoteLinkSuggestionListProps) => {
      if (!root || !element) return
      root.render(<NoteLinkSuggestionList ref={listRef} {...props} />)
      updatePosition(props.clientRect, element)
    },

    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (props.event.key === "Escape") {
        root?.unmount()
        element?.remove()
        root = null
        element = null
        return true
      }
      return listRef.current?.onKeyDown(props) ?? false
    },

    onExit: () => {
      root?.unmount()
      element?.remove()
      root = null
      element = null
    },
  }
}
