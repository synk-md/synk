"use client"

import * as React from "react"
import { RiCloseLine, RiHistoryLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import type { NoteHistoryState } from "@/hooks/use-note-history"

import { HistoryPanel } from "./history-panel"

import "@/components/custom-ui/members/members.scss"

export function HistoryButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button type="button" data-style="ghost" aria-label="History of this note" tooltip="History of this note" onClick={onOpen}>
      <RiHistoryLine className="tiptap-button-icon" />
    </Button>
  )
}

export type NoteHistoryDialogProps = {
  open: boolean
  onClose: () => void
  state: NoteHistoryState
  /** Restoring is an edit, so only where this device may edit. */
  canRestore: boolean
}

/** The note's restore points, restoring one, and naming the current state. */
export function NoteHistoryDialog({ open, onClose, state, canRestore }: NoteHistoryDialogProps) {
  const { refresh, history } = state

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose])

  if (!open || !history) return null

  return (
    <div
      className="mem-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="mem-dialog" role="dialog" aria-modal="true" aria-labelledby="note-history-heading">
        <div className="mem-header">
          <h3 id="note-history-heading">History of this note</h3>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>
        <HistoryPanel
          points={state.points}
          users={state.users}
          onPlan={(point) => history.plan(point.id)}
          onRestore={async (point) => {
            if (!canRestore) throw new Error("This note is read-only here, so it cannot be restored from this device.")
            await history.restore(point.id)
            await refresh()
          }}
          onCheckpoint={async (label) => {
            if (!(await history.take("checkpoint", label))) {
              throw new Error("This device cannot read the notebook's keys, so it cannot save a checkpoint.")
            }
            await refresh()
          }}
        />
      </div>
    </div>
  )
}

export default NoteHistoryDialog
