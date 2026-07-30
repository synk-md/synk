"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import "./quick-pick.scss"

export type QuickPickEntry = {
  id: string
  name: string
  path: string[]
}

type QuickPickProps = {
  open: boolean
  entries: QuickPickEntry[]
  onSelect: (id: string) => void
  onClose: () => void
  placeholder: string
  ariaLabel: string
  emptyMessage: string
  icon: React.ReactNode
}

// Subsequence fuzzy match: every character of `query` must appear in `name`,
// in order. Lower score (total gap between matched characters) is a better
// match; null means no match at all.
function fuzzyScore(name: string, query: string): number | null {
  if (!query) return 0

  const lowerName = name.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let score = 0
  let nameIndex = 0

  for (const char of lowerQuery) {
    const found = lowerName.indexOf(char, nameIndex)
    if (found === -1) return null
    score += found - nameIndex
    nameIndex = found + 1
  }

  return score
}

// Generic fuzzy-filtered, keyboard-navigable list in a modal — backs both
// the note quick-switcher and the "Move to" folder picker.
export function QuickPick({ open, entries, onSelect, onClose, placeholder, ariaLabel, emptyMessage, icon }: QuickPickProps) {
  const [query, setQuery] = React.useState("")
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const results = React.useMemo(() => {
    return entries
      .map((entry) => ({ entry, score: fuzzyScore(entry.name, query) }))
      .filter(
        (result): result is { entry: QuickPickEntry; score: number } => result.score !== null,
      )
      .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, 50)
      .map((result) => result.entry)
  }, [entries, query])

  React.useEffect(() => {
    if (!open) return
    setQuery("")
    setSelectedIndex(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  React.useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSelectedIndex((index) => (results.length ? (index + 1) % results.length : 0))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setSelectedIndex((index) =>
          results.length ? (index - 1 + results.length) % results.length : 0,
        )
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        const entry = results[selectedIndex]
        if (entry) onSelect(entry.id)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [open, results, selectedIndex, onSelect, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="quick-pick-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="quick-pick" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="qp-input-row">
          <span className="qp-input-icon" aria-hidden="true">{icon}</span>
          <input
            ref={inputRef}
            className="qp-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>

        <div className="qp-list" role="listbox">
          {results.length === 0 ? (
            <div className="qp-empty">{emptyMessage}</div>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`qp-item${index === selectedIndex ? " is-selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onSelect(entry.id)}
              >
                <span className="qp-item-name">{entry.name}</span>
                {entry.path.length > 0 && (
                  <span className="qp-item-path">{entry.path.join(" / ")}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
