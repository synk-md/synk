"use client"

import * as React from "react"
import { RiCloseLine, RiUserAddLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { ApproveRedemptionDialog } from "@/components/custom-ui/invitations/approve-redemption-dialog"
import { CreateInviteDialog } from "@/components/custom-ui/invitations/create-invite-dialog"
import { PendingInvites } from "@/components/custom-ui/invitations/pending-invites"
import { WorkspacePanel } from "@/components/custom-ui/workspace/workspace-panel"
import { useNotebookMembers, type PendingJoin } from "@/hooks/use-notebook-members"
import { currentDevice } from "@/lib/identity"

import "./members.scss"

export type NotebookMembersDialogProps = {
  open: boolean
  onClose: () => void
  notebookId: string | null
  /** Where an invitee should go. The secret never goes in here. */
  joinLinkFor: (notebookId: string) => string
}

/**
 * Who is in this notebook, and letting someone else in.
 *
 * The member list comes first and inviting second, for the same reason sharing
 * does: who can already see this is the question that decides whether to invite
 * at all.
 *
 * Only the owner sees the invite and approve controls. A member who cannot
 * admit is shown the list without them rather than being offered a button that
 * would fail - the grant is admin-gated in the library and the interface agrees
 * with it rather than discovering it.
 */
export function NotebookMembersDialog({
  open,
  onClose,
  notebookId,
  joinLinkFor,
}: NotebookMembersDialogProps) {
  const members = useNotebookMembers(open ? notebookId : null)
  const [inviting, setInviting] = React.useState(false)
  const [reviewing, setReviewing] = React.useState<PendingJoin | null>(null)
  const selfDid = currentDevice()?.identity.did

  React.useEffect(() => {
    if (!open) {
      setInviting(false)
      setReviewing(null)
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      if (inviting || reviewing) return
      onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, inviting, reviewing, onClose])

  if (!open || !notebookId) return null

  return (
    <>
      <div
        className="mem-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div
          className="mem-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notebook-members-heading"
        >
          <div className="mem-header">
            <h3 id="notebook-members-heading">Who can see this notebook</h3>
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

          <WorkspacePanel
            workspace={members.workspace}
            loading={members.loading}
            {...(selfDid === undefined ? {} : { selfDid })}
          />

          {members.canAdmit && (
            <>
              <PendingInvites
                invitations={members.invitations}
                awaiting={members.awaiting}
                onReview={setReviewing}
              />

              <div className="mem-actions">
                <Button className="mem-primary-btn is-active" onClick={() => setInviting(true)}>
                  <RiUserAddLine className="tiptap-button-icon" />
                  <span className="tiptap-button-text">Invite someone</span>
                </Button>
              </div>
            </>
          )}

          {!members.canAdmit && !members.loading && (
            <p className="mem-note">
              Only the person who created this notebook can invite others to it.
            </p>
          )}
        </div>
      </div>

      <CreateInviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onCreate={members.invite}
        joinLink={joinLinkFor(notebookId)}
      />

      <ApproveRedemptionDialog
        open={reviewing !== null}
        pending={reviewing}
        onClose={() => setReviewing(null)}
        onGrant={(pending) => members.admit(pending)}
        onReject={members.reject}
      />
    </>
  )
}

export default NotebookMembersDialog
