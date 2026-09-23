"use client"

import * as React from "react"
import { RiCloseLine, RiShieldKeyholeLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { deviceFingerprint, FINGERPRINT_PLACEHOLDER, fingerprintsMatch } from "@/lib/identity"

import "./device-manager.scss"

export type PendingDevice = {
  /** `did:key` of the device asking to be linked. */
  did: string
  /** What the new device calls itself. Untrusted - it chose this. */
  claimedName?: string
  requestedAt?: number
}

export type ApproveDeviceDialogProps = {
  open: boolean
  pending: PendingDevice | null
  /** Called only once the person has confirmed the fingerprint matches. */
  onApprove: (pending: PendingDevice) => Promise<void> | void
  onReject: (pending: PendingDevice) => void
  onClose: () => void
  className?: string
}

/**
 * Approving a new device, from a device that already has access.
 *
 * The whole security value of this dialog is the fingerprint comparison, so the
 * flow is built around it rather than around the button:
 *
 *   - the fingerprint is shown large, and the person is asked to read it off
 *     the *new* device and type it here
 *   - approve stays disabled until what they typed matches
 *   - the name the new device claims is shown as a claim, not a fact, because
 *     the new device chose it and an attacker would choose "Sindre's iPhone"
 *
 * Making the person retype rather than eyeball-and-click is deliberate. A
 * confirm button next to a displayed code gets clicked without reading it;
 * typing the code cannot be done without looking at both screens.
 *
 * The code is sixteen characters because that is 80 bits, which is what makes a
 * matching forgery not worth grinding for. It is a security parameter, not a
 * layout choice - see `deviceFingerprint`.
 */
export function ApproveDeviceDialog({
  open,
  pending,
  onApprove,
  onReject,
  onClose,
  className,
}: ApproveDeviceDialogProps) {
  const [expected, setExpected] = React.useState<string | null>(null)
  const [typed, setTyped] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setTyped("")
    setBusy(false)
    setError(null)
    if (!pending) {
      setExpected(null)
      return
    }
    let cancelled = false
    void deviceFingerprint(pending.did).then((value) => {
      if (!cancelled) setExpected(value)
    })
    return () => {
      cancelled = true
    }
  }, [pending])

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

  if (!open || !pending) return null

  const matches = expected !== null && typed.length > 0 && fingerprintsMatch(typed, expected)

  const approve = async () => {
    if (!matches || busy) return
    setBusy(true)
    setError(null)
    try {
      await onApprove(pending)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this device.")
      setBusy(false)
    }
  }

  return (
    <div
      className="dm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["dm-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-device-heading"
      >
        <div className="dm-header">
          <div className="dm-heading">
            <h3 id="approve-device-heading">Approve this device?</h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <p className="dm-body-text">
          A device is asking to join your account. It will be able to read and edit everything you
          can.
        </p>

        {pending.claimedName && (
          <p className="dm-claim">
            It calls itself <strong>{pending.claimedName}</strong>
            <span className="dm-claim-note">— a name it chose, not one we can verify</span>
          </p>
        )}

        <div className="dm-verify">
          <span className="dm-field-label">Check the code on the new device</span>
          <div className="dm-fingerprint-display" aria-label="Expected fingerprint">
            <RiShieldKeyholeLine aria-hidden="true" />
            <code>{expected ?? "…"}</code>
          </div>
          <p className="dm-hint">
            If the code on the other screen is different, someone else is trying to join. Reject
            this request.
          </p>

          <label htmlFor="approve-device-code" className="dm-field-label">
            Type it here to confirm
          </label>
          <input
            id="approve-device-code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              if (error) setError(null)
            }}
            placeholder={FINGERPRINT_PLACEHOLDER}
            className={["dm-input", typed && !matches ? "is-error" : ""].join(" ")}
            disabled={busy || expected === null}
            onKeyDown={(event) => {
              if (event.key === "Enter") void approve()
            }}
          />
          {typed && !matches && (
            <span className="dm-error" role="alert">
              That does not match the code above.
            </span>
          )}
          {error && (
            <span className="dm-error" role="alert">
              {error}
            </span>
          )}
        </div>

        <div className="dm-actions">
          <Button
            data-style="ghost"
            onClick={() => {
              onReject(pending)
              onClose()
            }}
          >
            <span className="tiptap-button-text">Reject</span>
          </Button>
          <Button
            className={["dm-primary-btn", matches ? "is-active" : ""].join(" ")}
            disabled={!matches || busy}
            onClick={() => void approve()}
          >
            <span className="tiptap-button-text">{busy ? "Approving…" : "Approve device"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ApproveDeviceDialog
