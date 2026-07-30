"use client"

import { RiAddLine, RiCloseLine, RiSearchLine } from "@remixicon/react"

import "./new-tab-view.scss"

type NewTabViewProps = {
  canCreateNote: boolean
  onCreateNote: () => void
  onFindNote: () => void
  onClose: () => void
}

export function NewTabView({
  canCreateNote,
  onCreateNote,
  onFindNote,
  onClose,
}: NewTabViewProps) {
  return (
    <div className="new-tab-view">
      <button
        type="button"
        className="new-tab-action"
        disabled={!canCreateNote}
        onClick={() => onCreateNote()}
      >
        <RiAddLine className="new-tab-action-icon" aria-hidden="true" />
        <span className="new-tab-action-label">Create new note</span>
        <span className="new-tab-action-shortcut">Ctrl + N</span>
      </button>

      <button type="button" className="new-tab-action" onClick={() => onFindNote()}>
        <RiSearchLine className="new-tab-action-icon" aria-hidden="true" />
        <span className="new-tab-action-label">Find note</span>
        <span className="new-tab-action-shortcut">Ctrl + P</span>
      </button>

      <button type="button" className="new-tab-action" onClick={() => onClose()}>
        <RiCloseLine className="new-tab-action-icon" aria-hidden="true" />
        <span className="new-tab-action-label">Close</span>
      </button>
    </div>
  )
}
