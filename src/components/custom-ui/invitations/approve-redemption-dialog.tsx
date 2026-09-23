"use client"

import * as React from "react"
import { RiCloseLine, RiTimeLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { FingerprintCompare } from "@/components/custom-ui/identity/fingerprint-compare"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { isInvitationExpired, type Invitation, type Redemption } from "@/lib/directory"

import "./invitations.scss"

export type PendingRedemption = {
  invitation: Invitation
  redemption: Redemption
}

export type ApproveRedemptionDialogProps = {
  open: boolean
  pending: PendingRedemption | null
  /** Called only after the fingerprint has been confirmed out of band. */
  onGrant: (pending: PendingRedemption) => Promise<void> | void
  onReject: (pending: PendingRedemption) => void
  onClose: () => void
  now?: number
  className?: string
}

/**
 * The admin's approve step: someone redeemed an invitation, should they be let
 * in?
 *
 * The trap this screen is built to avoid is that the name on display came from
 * a trusted source - the admin's own invitation - and therefore *looks*
 * confirmed. It is not. It says who the admin meant to invite, not who turned
 * up holding the secret. If the code leaked, the person redeeming is someone
 * else entirely and the name is exactly as reassuring as before.
 *
 * So the name is shown with an explicit unverified badge until the fingerprint
 * has been compared out of band, and the grant button stays disabled until
 * then. There is no "I'll check later" path, because that is the path everyone
 * takes.
 */
export function ApproveRedemptionDialog({
  open,
  pending,
  onGrant,
  onReject,
  onClose,
  now = Date.now(),
  className,
}: ApproveRedemptionDialogProps) {
  const [verified, setVerified] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setVerified(false)
    setBusy(false)
    setError(null)
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

  const onMatchChange = React.useCallback((matched: boolean) => {
    setVerified(matched)
  }, [])

  if (!open || !pending) return null

  const { invitation, redemption } = pending
  const expired = isInvitationExpired(invitation, now)

  const grant = async () => {
    if (!verified || busy || expired) return
    setBusy(true)
    setError(null)
    try {
      await onGrant(pending)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not admit this person.")
      setBusy(false)
    }
  }

  return (
    <div
      className="inv-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["inv-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-redemption-heading"
      >
        <div className="inv-header">
          <div className="inv-heading">
            <h3 id="approve-redemption-heading">Let them in?</h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <div className="inv-subject">
          <span className="inv-subject-name">{invitation.label}</span>
          <IdentityBadge assurance={verified ? "verified" : "invited"} />
        </div>

        <p className="inv-body-text">
          {verified ? (
            <>
              You have confirmed their device key. Admitting them gives this device access as{" "}
              <strong>{invitation.label}</strong>.
            </>
          ) : (
            <>
              Someone redeemed the invitation you addressed to{" "}
              <strong>{invitation.label}</strong>. That is the name <em>you</em> chose — it does not
              tell you who redeemed it. If the code reached anyone else, this is them.
            </>
          )}
        </p>

        {expired && (
          <div className="inv-warning is-critical" role="alert">
            <span className="inv-warning-icon" aria-hidden="true">
              <RiTimeLine />
            </span>
            <div>
              <strong>This invitation has expired.</strong>
              <p>Issue a new one rather than admitting from a stale request.</p>
            </div>
          </div>
        )}

        <FingerprintCompare
          did={redemption.did}
          onMatchChange={onMatchChange}
          inputId="approve-redemption-code"
          prompt="Ask them to read out the code their app shows"
          mismatchGuidance="If the codes differ, the invitation was redeemed by someone else. Reject it and issue a new one."
          disabled={expired || busy}
        />

        {error && (
          <span className="inv-error" role="alert">
            {error}
          </span>
        )}

        <div className="inv-actions">
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
            className={["inv-primary-btn", verified && !expired ? "is-active" : ""].join(" ")}
            disabled={!verified || busy || expired}
            onClick={() => void grant()}
          >
            <span className="tiptap-button-text">{busy ? "Admitting…" : "Admit"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ApproveRedemptionDialog
