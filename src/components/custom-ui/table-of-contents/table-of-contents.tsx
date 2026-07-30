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

export const ToCItem: React.FC<{ item: ToCItemData; onItemClick: OnItemClick }> = ({ item, onItemClick }) => {
  return (
    <div
      className={`toc-item ${item.isActive && !item.isScrolledOver ? 'is-active' : ''} ${item.isScrolledOver ? 'is-scrolled-over' : ''}`}
      style={{ ['--level' as any]: item.level }}
    >
      <a href={`#${item.id}`} onClick={(e) => onItemClick(e, item.id)} data-item-index={item.itemIndex}>
        {item.itemIndex != null && <span className="toc-item__index">{item.itemIndex}.</span>}
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

  return (
    <nav className="table-of-contents" aria-label="Table of contents">
      {items.length === 0
        ? <ToCEmptyState />
        : items.map((item) => (
          <ToCItem onItemClick={onItemClick} key={item.id} item={item} />
        ))}
    </nav>
  )
}
