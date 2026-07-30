"use client"

import * as React from "react"
import { RiCloseLine } from "@remixicon/react"
import { useNotebooks } from "@/hooks/use-notebooks"

// tiptap UI primitive buttons
import { Button } from "@/components/tiptap-ui-primitive/button"

// styles
import "./new-notebook-dialog.scss"

export type NewNotebookDialogProps = {
  open: boolean
  onClose: () => void
  onCreated?: (notebookId: string, noteId: string) => void
  className?: string
}

export function NewNotebookDialog({
  open,
  onClose,
  onCreated,
  className,
}: NewNotebookDialogProps) {
  const { createNotebook } = useNotebooks()
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName("")
      setError(null)
      setBusy(false)
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return

    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose])

  if (!open) return null

  const hasName = name.trim().length > 0

  const create = async () => {
    if (!hasName || busy) return
    setBusy(true)
    setError(null)
    try {
      const { notebookId, welcomeNoteId } = await createNotebook(name.trim())
      onClose()
      onCreated?.(notebookId, welcomeNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.")
      setBusy(false)
    }
  }

  return (
    <div
      className="new-notebook-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={["new-notebook-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label="New notebook"
      >
        <div className="nnd-header">
          <div className="nnd-heading">
            <h3>New notebook</h3>
          </div>
          <Button
            type="button"
            data-style="ghost"
            aria-label="Close"
            tooltip="Close"
            onClick={onClose}
          >
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <label htmlFor="new-notebook-name" className="nnd-field-label">Name</label>
        <input
          id="new-notebook-name"
          autoFocus
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          placeholder="e.g. Study notes, Work, Personal"
          className={["nnd-input", error ? "is-error" : ""].join(" ")}
          disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") create() }}
        />
        {error && <span className="nnd-error">{error}</span>}

        <div className="nnd-actions">
          <Button data-style="ghost" onClick={onClose}>
            <span className="tiptap-button-text">Cancel</span>
          </Button>
          <Button
            className={["nnd-create-btn", hasName ? "is-active" : ""].join(" ")}
            disabled={!hasName || busy}
            onClick={create}
          >
            <span className="tiptap-button-text">{busy ? "Creating…" : "Create notebook"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default NewNotebookDialog
