"use client"

import * as React from "react"
import { RiCloseLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { FingerprintCompare } from "@/components/custom-ui/identity/fingerprint-compare"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"

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
 * Approving a new device from one that already has access. The security value
 * is entirely in the fingerprint comparison, so the flow is built around it:
 * retype rather than eyeball-and-click, approve disabled until it matches, and
 * the claimed name shown as a claim - an attacker would choose a good one.
 *
 * The length is a security parameter, not a layout choice; see
 * `deviceFingerprint`.
 */
export function ApproveDeviceDialog({
  open,
  pending,
  onApprove,
  onReject,
  onClose,
  className,
}: ApproveDeviceDialogProps) {
  const [matches, setMatches] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setMatches(false)
    setBusy(false)
    setError(null)
  }, [pending])

  const onMatchChange = React.useCallback((matched: boolean) => {
    setMatches(matched)
  }, [])

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
            It calls itself <strong>{pending.claimedName}</strong>{" "}
            <IdentityBadge assurance="self-asserted" />
            <span className="dm-claim-note">— a name it chose, not one we can verify</span>
          </p>
        )}

        <FingerprintCompare
          did={pending.did}
          onMatchChange={onMatchChange}
          inputId="approve-device-code"
          prompt="Check the code on the new device"
          mismatchGuidance="If the code on the other screen is different, someone else is trying to join. Reject this request."
          disabled={busy}
        />

        {error && (
          <span className="dm-error" role="alert">
            {error}
          </span>
        )}

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
