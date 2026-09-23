"use client"

import * as React from "react"
import { RiBookmark3Line, RiCloseLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"

import "./history.scss"

export type CheckpointDialogProps = {
  open: boolean
  onClose: () => void
  onCreate: (label: string) => Promise<void> | void
  className?: string
}

/**
 * Naming a point so it survives.
 *
 * Automatic points are kept for a bounded window and then degrade to markers -
 * the timeline stays complete, but the contents go to the archive. A named
 * checkpoint keeps its contents locally regardless of age, which is the whole
 * reason to name one, so the dialog says that rather than implying a name is
 * decoration.
 */
export function CheckpointDialog({ open, onClose, onCreate, className }: CheckpointDialogProps) {
  const [label, setLabel] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) return
    setLabel("")
    setBusy(false)
    setError(null)
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

  const named = label.trim().length > 0

  const create = async () => {
    if (!named || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(label.trim())
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save a checkpoint.")
      setBusy(false)
    }
  }

  return (
    <div
      className="hx-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["hx-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkpoint-heading"
      >
        <div className="hx-header">
          <div className="hx-heading-row">
            <h3 id="checkpoint-heading">
              <RiBookmark3Line aria-hidden="true" /> Name this point
            </h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <p className="hx-body-text">
          Saves the document as it is now, under a name you choose. Named points are kept in full on
          this device; unnamed ones are tidied away after a while and their contents move to the
          archive.
        </p>

        <label htmlFor="checkpoint-label" className="hx-field-label">
          What to call it
        </label>
        <input
          id="checkpoint-label"
          autoFocus
          autoComplete="off"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
            if (error) setError(null)
          }}
          placeholder="e.g. Before the rewrite"
          className="hx-input"
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create()
          }}
        />

        {error && (
          <span className="hx-error" role="alert">
            {error}
          </span>
        )}

        <div className="hx-actions">
          <Button data-style="ghost" onClick={onClose}>
            <span className="tiptap-button-text">Cancel</span>
          </Button>
          <Button
            className={["hx-primary-btn", named ? "is-active" : ""].join(" ")}
            disabled={!named || busy}
            onClick={() => void create()}
          >
            <span className="tiptap-button-text">{busy ? "Saving…" : "Save checkpoint"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CheckpointDialog
