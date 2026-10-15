"use client"

import * as React from "react"
import { RiAlertLine, RiArrowGoBackLine, RiCloseLine, RiUserLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import type { RestorePlan, RestorePoint, TimelineAttribution } from "@/lib/history"

import "./history.scss"

export type RestoreDialogProps = {
  open: boolean
  onClose: () => void
  point: RestorePoint | null
  /** Computed by the caller, so the dialog shows what will actually happen. */
  plan: RestorePlan | null
  planning?: boolean
  /** Original authors of the content coming back, resolved for display. */
  origins?: readonly TimelineAttribution[]
  onRestore: (point: RestorePoint) => Promise<void> | void
  className?: string
}

/**
 * Going back to a point.
 *
 * The thing to get across is that this is **not an undo**. It publishes a new
 * edit that makes the document look the way it did, attributed to whoever
 * pressed the button, visible to everyone, and itself a point on the timeline.
 * Nothing is erased and nothing is hidden, which also means nothing is secret:
 * someone expecting a private rollback needs to be told otherwise before they
 * press it, not after.
 *
 * The second thing is authorship. Text that comes back keeps the name of
 * whoever wrote it, because the restore records that separately from the
 * structs it had to recreate. Saying so stops the reasonable worry that
 * restoring means claiming someone else's work.
 */
export function RestoreDialog({
  open,
  onClose,
  point,
  plan,
  planning = false,
  origins = [],
  onRestore,
  className,
}: RestoreDialogProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setBusy(false)
    setError(null)
  }, [point])

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

  if (!open || !point) return null

  const others = origins.filter((origin) => origin.author !== point.attribution.author)

  const restore = async () => {
    if (busy || !point.restorable) return
    setBusy(true)
    setError(null)
    try {
      await onRestore(point)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore to that point.")
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
        aria-labelledby="restore-heading"
      >
        <div className="hx-header">
          <div className="hx-heading-row">
            <h3 id="restore-heading">
              {point.kind === "session"
                ? `Go back to the end of ${point.attribution.label}'s edits?`
                : `Go back to ${point.label ?? new Date(point.createdAt).toLocaleString()}?`}
            </h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <ul className="hx-effects">
          <li>
            <span className="hx-effect-icon" aria-hidden="true">
              <RiArrowGoBackLine />
            </span>
            <span>
              <strong>This is a new edit, not an undo.</strong>
              <span className="hx-note">
                The document moves forward to look the way it did then. Nothing is erased, and this
                restore appears on the timeline under your name — everyone working here will see it.
              </span>
            </span>
          </li>
          <li>
            <span className="hx-effect-icon" aria-hidden="true">
              <RiUserLine />
            </span>
            <span>
              <strong>Writing that comes back keeps its author.</strong>
              <span className="hx-note">
                {others.length > 0
                  ? `Text originally written by ${others.map((origin) => origin.label).join(", ")} stays theirs. You are recorded as having restored it, not as having written it.`
                  : "You are recorded as having restored it, not as having written it."}
              </span>
            </span>
          </li>
        </ul>

        {planning && (
          <p className="hx-note" role="status">
            Working out what would change…
          </p>
        )}

        {plan?.noop && (
          <div className="hx-warning" role="note">
            <span className="hx-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>Nothing would change.</strong>
              <p>The document already matches this point.</p>
            </div>
          </div>
        )}

        {plan && !plan.noop && (
          <p className="hx-summary">
            <strong>{plan.changed}</strong> {plan.changed === 1 ? "item" : "items"} of content would
            be rewritten. Anything written since then is removed from the document — it stays in the
            history, and you can come back to it the same way.
          </p>
        )}

        {plan && plan.skipped.length > 0 && (
          <div className="hx-warning" role="note">
            <span className="hx-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>Part of this point cannot be restored.</strong>
              <p>
                {plan.skipped.join(", ")} {plan.skipped.length === 1 ? "is" : "are"} not present in
                the document as it stands, so it is left alone rather than guessed at.
              </p>
            </div>
          </div>
        )}

        {!point.restorable && (
          <div className="hx-warning is-critical" role="alert">
            <span className="hx-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>
                {point.blocker === "outside-visible-history"
                  ? "This point is from before you had access."
                  : point.blocker === "payload-archived"
                    ? "The contents of this point are not on this device."
                    : "The document is already at this point."}
              </strong>
              <p>
                {point.blocker === "outside-visible-history"
                  ? "It was saved under a key you do not hold, so it cannot be opened here."
                  : point.blocker === "payload-archived"
                    ? "Fetch it from the archive first, then try again."
                    : "There is nothing to restore."}
              </p>
            </div>
          </div>
        )}

        {error && (
          <span className="hx-error" role="alert">
            <RiAlertLine aria-hidden="true" /> {error}
          </span>
        )}

        <div className="hx-actions">
          <Button data-style="ghost" onClick={onClose}>
            <span className="tiptap-button-text">Cancel</span>
          </Button>
          <Button
            className={["hx-primary-btn", point.restorable && !plan?.noop ? "is-active" : ""].join(" ")}
            disabled={busy || planning || !point.restorable || plan?.noop === true}
            onClick={() => void restore()}
          >
            <span className="tiptap-button-text">{busy ? "Restoring…" : "Restore"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default RestoreDialog
