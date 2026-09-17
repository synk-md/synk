import * as React from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

export interface ToCItemData {
  id: string
  level: number
  isActive?: boolean
  isScrolledOver?: boolean
  itemIndex?: number
  textContent: string
}

type OnItemClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => void
type OnToggle = (id: string) => void

export const ToCItem: React.FC<{
  item: ToCItemData
  hasChildren: boolean
  isCollapsed: boolean
  onItemClick: OnItemClick
  onToggle: OnToggle
}> = ({ item, hasChildren, isCollapsed, onItemClick, onToggle }) => {
  return (
    <div
      className={`toc-item ${item.isActive && !item.isScrolledOver ? 'is-active' : ''} ${item.isScrolledOver ? 'is-scrolled-over' : ''}`}
      style={{ ['--level' as any]: item.level }}
    >
      <a href={`#${item.id}`} onClick={(e) => onItemClick(e, item.id)} data-item-index={item.itemIndex}>
        <span
          className={`toc-item__chevron ${hasChildren ? (isCollapsed ? 'right' : 'bottom') : 'empty'}`}
          onClick={(e) => {
            if (!hasChildren) return
            e.preventDefault()
            e.stopPropagation()
            onToggle(item.id)
          }}
        />
        <span className="toc-item__label">{item.textContent}</span>
      </a>
    </div>
  )
}

export const ToCEmptyState: React.FC = () => (
  <div className="toc-empty-state">
    <p>Your outline will appear here</p>
  </div>
)

export const ToC: React.FC<{ items?: ToCItemData[]; editor?: Editor | null }> = ({ items = [], editor }) => {
  const [collapsedIds, setCollapsedIds] = React.useState<Set<string>>(() => new Set())

  const onToggle: OnToggle = (id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onItemClick: OnItemClick = (e, id) => {
    e.preventDefault()
    if (!editor) return

    // NOTE: your original selector missed a closing bracket
    const element = editor.view.dom.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)
    if (!element) return

    const pos = editor.view.posAtDOM(element, 0)
    const tr = editor.view.state.tr
    tr.setSelection(new TextSelection(tr.doc.resolve(pos)))
    editor.view.dispatch(tr)
    editor.view.focus()

    if (history.pushState) history.pushState(null, '', `#${id}`)

    editor
    .chain()
    .focus()
    .setTextSelection(pos)
    .scrollIntoView()
    .run()
  }

  const { visibleItems, hasChildrenMap } = React.useMemo(() => {
    const hasChildren = new Map<string, boolean>()
    items.forEach((item, i) => {
      const next = items[i + 1]
      hasChildren.set(item.id, !!next && next.level > item.level)
    })

    const visible: ToCItemData[] = []
    const collapseStack: number[] = []
    for (const item of items) {
      while (collapseStack.length && item.level <= collapseStack[collapseStack.length - 1]) {
        collapseStack.pop()
      }
      if (collapseStack.length === 0) visible.push(item)
      if (collapsedIds.has(item.id) && hasChildren.get(item.id)) {
        collapseStack.push(item.level)
      }
    }

    return { visibleItems: visible, hasChildrenMap: hasChildren }
  }, [items, collapsedIds])

  return (
    <nav className="table-of-contents" aria-label="Table of contents">
      {visibleItems.length === 0
        ? <ToCEmptyState />
        : visibleItems.map((item) => (
          <ToCItem
            onItemClick={onItemClick}
            onToggle={onToggle}
            key={item.id}
            item={item}
            hasChildren={!!hasChildrenMap.get(item.id)}
            isCollapsed={collapsedIds.has(item.id)}
          />
        ))}
    </nav>
  )
}
