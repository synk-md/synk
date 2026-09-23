"use client"

import { RiMailSendLine, RiTimeLine, RiUserAddLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { isInvitationExpired, type Invitation } from "@/lib/directory"

import type { PendingRedemption } from "./approve-redemption-dialog"

import "./invitations.scss"

export type PendingInvitesProps = {
  /** Invitations sent, whether or not anyone has redeemed them. */
  invitations: readonly Invitation[]
  /** Redemptions waiting on an admin decision. */
  awaiting: readonly PendingRedemption[]
  onReview: (pending: PendingRedemption) => void
  onRevoke?: (invitation: Invitation) => void
  now?: number
  className?: string
}

/**
 * Outstanding invitations, and the ones someone has answered.
 *
 * Every row carries an unverified badge, including the ones that came from the
 * admin's own invitation. A list is where a name gets skimmed and taken as
 * fact, so the badge has to be present at the point of skimming rather than
 * only inside the dialog.
 */
export function PendingInvites({
  invitations,
  awaiting,
  onReview,
  onRevoke,
  now = Date.now(),
  className,
}: PendingInvitesProps) {
  const answered = new Set(awaiting.map((entry) => entry.invitation.invitationId))
  const unanswered = invitations.filter((invitation) => !answered.has(invitation.invitationId))

  if (invitations.length === 0 && awaiting.length === 0) {
    return (
      <p className="inv-empty" role="status">
        No invitations outstanding.
      </p>
    )
  }

  return (
    <div className={["inv-pending", className ?? ""].join(" ")}>
      {awaiting.length > 0 && (
        <section aria-labelledby="inv-awaiting-heading">
          <h4 id="inv-awaiting-heading" className="inv-section-heading">
            Waiting for you
          </h4>
          <ul className="inv-list">
            {awaiting.map((entry) => (
              <li key={entry.redemption.invitationId} className="inv-row is-actionable">
                <span className="inv-row-icon" aria-hidden="true">
                  <RiUserAddLine />
                </span>
                <span className="inv-row-main">
                  <span className="inv-row-name">
                    {entry.invitation.label}
                    <IdentityBadge assurance="invited" />
                  </span>
                  <span className="inv-row-meta">
                    Redeemed {new Date(entry.redemption.redeemedAt).toLocaleDateString()} — check
                    their fingerprint before admitting
                  </span>
                </span>
                <Button
                  className="inv-primary-btn is-active"
                  onClick={() => onReview(entry)}
                >
                  <span className="tiptap-button-text">Review</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unanswered.length > 0 && (
        <section aria-labelledby="inv-sent-heading">
          <h4 id="inv-sent-heading" className="inv-section-heading">
            Sent
          </h4>
          <ul className="inv-list">
            {unanswered.map((invitation) => {
              const expired = isInvitationExpired(invitation, now)
              return (
                <li
                  key={invitation.invitationId}
                  className={["inv-row", expired ? "is-expired" : ""].join(" ")}
                >
                  <span className="inv-row-icon" aria-hidden="true">
                    {expired ? <RiTimeLine /> : <RiMailSendLine />}
                  </span>
                  <span className="inv-row-main">
                    <span className="inv-row-name">
                      {invitation.label}
                      <IdentityBadge assurance="invited" />
                    </span>
                    <span className="inv-row-meta">
                      {expired
                        ? `Expired ${new Date(invitation.expiresAt).toLocaleDateString()}`
                        : `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
                    </span>
                  </span>
                  {onRevoke && (
                    <Button
                      data-style="ghost"
                      aria-label={`Cancel invitation for ${invitation.label}`}
                      onClick={() => onRevoke(invitation)}
                    >
                      <span className="tiptap-button-text">Cancel</span>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

export default PendingInvites
