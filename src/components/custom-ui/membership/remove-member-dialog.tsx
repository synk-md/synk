"use client"

import * as React from "react"
import { RiAlertLine, RiCloseLine, RiEyeOffLine, RiQuillPenLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"

import { removalRequest, type MemberView, type RemovalRequest } from "./membership-model"

import "./membership.scss"

export type RemoveMemberDialogProps = {
  open: boolean
  onClose: () => void
  member: MemberView | null
  /** Shown in full: an omission locks someone out. */
  remaining: readonly { did: string; label: string }[]
  onRemove: (request: RemovalRequest, reason: string | undefined) => Promise<void> | void
  className?: string
}

/**
 * Removing a member: revoke, rotate, reseal.
 *
 * The two halves fail differently - rotation denies reads immediately,
 * revocation stops writes only once it propagates - so they are shown as two
 * rows rather than one promise, or a normal minute of lingering reads as the
 * promise being broken.
 *
 * What removal cannot undo is stated here rather than discovered later. Who
 * keeps access is listed in full, because the reseal goes to exactly that set.
 */
export function RemoveMemberDialog({
  open,
  onClose,
  member,
  remaining,
  onRemove,
  className,
}: RemoveMemberDialogProps) {
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setReason("")
    setBusy(false)
    setError(null)
  }, [member])

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

  if (!open || !member) return null

  const request = removalRequest(member)

  const remove = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRemove(request, reason.trim() || undefined)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this member.")
      setBusy(false)
    }
  }

  return (
    <div
      className="mb-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["mb-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-member-heading"
      >
        <div className="mb-header">
          <div className="mb-heading">
            <h3 id="remove-member-heading">Remove {member.label}?</h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <ul className="mb-effects-table">
          <li>
            <span className="mb-effect-icon" aria-hidden="true">
              <RiEyeOffLine />
            </span>
            <span>
              <strong>Reading stops straight away.</strong>
              <span className="mb-note">
                The content key is replaced, so nothing written from now on is readable to them —
                however long they keep the keys they already have, and whether or not any other
                device hears about this.
              </span>
            </span>
          </li>
          <li>
            <span className="mb-effect-icon" aria-hidden="true">
              <RiQuillPenLine />
            </span>
            <span>
              <strong>Writing stops as this spreads.</strong>
              <span className="mb-note">
                Each device stops accepting their edits when the withdrawal reaches it, usually in
                seconds. Expect to see them linger briefly — that is the system working, not
                failing.
              </span>
            </span>
          </li>
        </ul>

        <div className="mb-warning" role="note">
          <span className="mb-warning-icon" aria-hidden="true">
            <RiAlertLine />
          </span>
          <div>
            <strong>What this cannot undo.</strong>
            <p>
              They keep everything they have already read. Their copy stays on their device to
              read, and the app tells them they were removed; nothing they write would be accepted
              by anyone.
            </p>
          </div>
        </div>

        <span className="mb-field-label">
          {request.deviceDids.length === 1
            ? "This withdraws 1 device key"
            : `This withdraws ${String(request.deviceDids.length)} device keys`}
        </span>
        <p className="mb-note">
          Access is held by keys, not by people, so every one of {member.label}&rsquo;s keys is
          withdrawn together. Leaving one would leave them their access.
        </p>

        <span className="mb-field-label">Everyone who keeps access</span>
        {remaining.length === 0 ? (
          <div className="mb-warning is-critical" role="alert">
            <span className="mb-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>Nobody else is listed.</strong>
              <p>
                The new key would be sealed to no one, and this notebook would become unreadable to
                everyone including you. Check the list before continuing.
              </p>
            </div>
          </div>
        ) : (
          <ul className="mb-remaining">
            {remaining.map((person) => (
              <li key={person.did}>{person.label}</li>
            ))}
          </ul>
        )}

        <label htmlFor="remove-reason" className="mb-field-label">
          Reason <span className="mb-optional">optional, recorded with the withdrawal</span>
        </label>
        <input
          id="remove-reason"
          autoComplete="off"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. left the team"
          className="mb-input"
          disabled={busy}
        />

        {error && (
          <span className="mb-error" role="alert">
            <RiAlertLine aria-hidden="true" /> {error}
          </span>
        )}

        <div className="mb-actions">
          <Button data-style="ghost" onClick={onClose}>
            <span className="tiptap-button-text">Keep them</span>
          </Button>
          <Button
            className="mb-danger-btn"
            disabled={busy || remaining.length === 0}
            onClick={() => void remove()}
          >
            <span className="tiptap-button-text">
              {busy ? "Removing…" : `Remove ${member.label}`}
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default RemoveMemberDialog
