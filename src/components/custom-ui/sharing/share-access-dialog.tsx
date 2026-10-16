"use client"

import * as React from "react"
import { RiAlertLine, RiCloseLine, RiUserAddLine, RiUserSharedLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import type { ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"
import { ApproveRedemptionDialog } from "@/components/custom-ui/invitations/approve-redemption-dialog"
import { CreateInviteDialog } from "@/components/custom-ui/invitations/create-invite-dialog"
import { PendingInvites } from "@/components/custom-ui/invitations/pending-invites"
import { AdmissionProgress } from "@/components/custom-ui/members/admission-progress"
import { WorkspacePanel } from "@/components/custom-ui/workspace/workspace-panel"
import { useNoteAdmission } from "@/hooks/use-note-admission"
import { SHARING_CEILING, SHARING_CEILING_REASON, useNoteSharing } from "@/hooks/use-note-sharing"
import { useNotebookMembers, type PendingJoin } from "@/hooks/use-notebook-members"
import type { LinkAccess } from "@/lib/note-meta"
import { getNotebookLinkAccess, setNotebookLinkAccess } from "@/lib/notebook-meta"
import { currentDevice } from "@/lib/identity"
import { encryptedSyncEnabled } from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

import { AccessList } from "./access-list"
import { ShareDialog } from "./share-dialog"

import "@/components/custom-ui/members/members.scss"
import "./sharing.scss"

export type ShareAccessDialogProps = {
  open: boolean
  onClose: () => void
  notebookId: string
  notebookName: string
  /** The note in view, with its link setting. Without one the dialog is about the notebook. */
  note?: { id: string; linkAccess: LinkAccess; onLinkAccessChange: (access: LinkAccess) => void } | null
  /** Who has the note open right now. */
  viewers?: readonly ActiveUser[]
  joinLinkFor: (notebookId: string) => string
}

type Scope = "note" | "notebook"

const LINK_OPTIONS: { value: LinkAccess; label: string }[] = [
  { value: "restricted", label: "Off" },
  { value: "view", label: "Anyone with the link can read" },
  { value: "edit", label: "Anyone with the link can edit" },
]

/**
 * Everything about who can reach a note or its notebook, in one place.
 *
 * Organised by what someone is trying to do rather than by how access works
 * underneath: the people who have it and inviting more, then a link for
 * anyone, then who is looking now. One scope switch drives all three, so they
 * cannot disagree about what is being shared.
 */
export function ShareAccessDialog({
  open,
  onClose,
  notebookId,
  notebookName,
  note,
  viewers,
  joinLinkFor,
}: ShareAccessDialogProps) {
  const [scope, setScope] = React.useState<Scope>(note ? "note" : "notebook")
  const [granting, setGranting] = React.useState(false)
  const [inviting, setInviting] = React.useState(false)
  const [reviewing, setReviewing] = React.useState<PendingJoin | null>(null)
  const [notebookLink, setNotebookLink] = React.useState<LinkAccess>("restricted")
  const [copied, setCopied] = React.useState(false)

  const members = useNotebookMembers(open ? notebookId : null)
  const admission = useNoteAdmission(notebookId)
  const sharing = useNoteSharing(notebookId, note?.id ?? null, open)
  const selfDid = currentDevice()?.identity.did

  React.useEffect(() => {
    if (open) return
    setScope(note ? "note" : "notebook")
    setGranting(false)
    setInviting(false)
    setReviewing(null)
    setCopied(false)
  }, [open, note])

  React.useEffect(() => {
    if (!open) return
    const { meta, idb } = createNotebookIndexDoc(notebookId)
    let disposed = false
    const apply = () => {
      if (!disposed) setNotebookLink(getNotebookLinkAccess(meta))
    }
    apply()
    meta.observe(apply)
    idb.whenSynced.then(apply).catch(() => undefined)
    return () => {
      disposed = true
      meta.unobserve(apply)
    }
  }, [open, notebookId])

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || granting || inviting || reviewing) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, granting, inviting, reviewing, onClose])

  if (!open) return null

  const onNote = scope === "note" && note
  const label = onNote ? "this note" : notebookName
  const resource = sharing?.scopes.find((each) => (onNote ? each.label === "this note" : each.label === "the whole notebook"))
  const linkAccess = onNote ? note.linkAccess : notebookLink
  const linkUrl = `${window.location.origin}/s/${notebookId}${onNote ? `/${note.id}` : ""}`
  const settled = members.workspace?.ownership.status === "established"
  const count = members.workspace?.users.length ?? 0

  const changeLink = (access: LinkAccess) => {
    if (onNote) {
      note.onLinkAccessChange(access)
      return
    }
    setNotebookLinkAccess(createNotebookIndexDoc(notebookId).meta, access)
    setNotebookLink(access)
  }

  const copy = () => {
    void navigator.clipboard?.writeText(linkUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <>
      <div
        className="shr-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div className="shr-dialog shr-share" role="dialog" aria-modal="true" aria-labelledby="share-access-heading">
          <div className="shr-share-top">
            <div className="shr-header">
              <div className="shr-heading">
                <h3 id="share-access-heading">Share {onNote ? "this note" : `“${notebookName}”`}</h3>
              </div>
              <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
                <RiCloseLine className="tiptap-button-icon" />
              </Button>
            </div>

            {note && (
              <div className="shr-tabs" role="tablist" aria-label="What to share">
                {(["note", "notebook"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={scope === option}
                    className={["shr-tab", scope === option ? "is-selected" : ""].join(" ")}
                    onClick={() => setScope(option)}
                  >
                    {option === "note" ? "This note" : "Whole notebook"}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="shr-share-body">
            <section className="shr-section" aria-labelledby="share-people-heading">
              <h4 id="share-people-heading" className="shr-section-title">
                People
                {settled && <span className="shr-section-count">{count === 1 ? "1 member" : `${String(count)} members`}</span>}
              </h4>

              <AdmissionProgress run={admission.run} onCancel={admission.cancel} />

              {!settled || !sharing || !resource ? (
                <WorkspacePanel
                  workspace={members.workspace}
                  loading={members.loading}
                  {...(selfDid === undefined ? {} : { selfDid })}
                />
              ) : (
                <AccessList
                  capabilities={sharing.capabilities}
                  resource={resource.resource}
                  resourceLabel={resource.label}
                  context={sharing.context}
                  actor={sharing.actor}
                  people={sharing.people}
                  onRevoke={(entry, plan) => sharing.onRevoke(entry, plan, resource)}
                  onChangeLevel={(entry, ability) => sharing.onChangeLevel(entry, ability, resource)}
                  ceiling={SHARING_CEILING}
                  ceilingReason={SHARING_CEILING_REASON}
                  {...(resource.min ? { min: resource.min } : {})}
                  {...(resource.minReason ? { minReason: resource.minReason } : {})}
                  nameOf={sharing.nameOf}
                />
              )}

              {members.canAdmit && (
                <PendingInvites
                  invitations={members.invitations}
                  awaiting={members.awaiting}
                  onReview={setReviewing}
                  onRevoke={(invitation) => void members.cancel(invitation)}
                  codeFor={members.codeFor}
                />
              )}

              <div className="shr-actions">
                {sharing && resource && count > 1 && (
                  <Button data-style="ghost" onClick={() => setGranting(true)}>
                    <RiUserSharedLine className="tiptap-button-icon" />
                    <span className="tiptap-button-text">Give access to {resource.label}</span>
                  </Button>
                )}
                {members.canAdmit && (
                  <Button className="shr-primary-btn is-active" onClick={() => setInviting(true)}>
                    <RiUserAddLine className="tiptap-button-icon" />
                    <span className="tiptap-button-text">Invite someone</span>
                  </Button>
                )}
              </div>
              {!members.canAdmit && !members.loading && (
                <p className="shr-hint">Only the notebook's owner, on any of their devices, can invite people.</p>
              )}
            </section>

            <section className="shr-section" aria-labelledby="share-link-heading">
              <h4 id="share-link-heading" className="shr-section-title">
                Link
              </h4>
              <div className="shr-scopes" role="radiogroup" aria-label={`Link to ${label}`}>
                {LINK_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    htmlFor={`link-${option.value}`}
                    className={["shr-scope", linkAccess === option.value ? "is-selected" : ""].join(" ")}
                  >
                    <input
                      id={`link-${option.value}`}
                      type="radio"
                      name="share-link"
                      checked={linkAccess === option.value}
                      onChange={() => changeLink(option.value)}
                    />
                    <span className="shr-level-label">{option.label}</span>
                  </label>
                ))}
              </div>
              {linkAccess !== "restricted" && (
                <>
                  <div className="shr-link-row">
                    <input readOnly value={linkUrl} aria-label="Link to copy" onFocus={(event) => event.currentTarget.select()} />
                    <Button type="button" onClick={copy}>
                      <span className="tiptap-button-text">{copied ? "Copied" : "Copy"}</span>
                    </Button>
                  </div>
                  <div className="shr-warning" role="note">
                    <span className="shr-warning-icon" aria-hidden="true">
                      <RiAlertLine />
                    </span>
                    <div>
                      <strong>A link is readable by whoever holds it.</strong>
                      <p>
                        {onNote ? "This note travels" : "Every note in this notebook travels"} unencrypted to anyone with
                        it, and they need no invitation. People invited above read it with keys of their own.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </section>

            {onNote && viewers && viewers.length > 0 && (
              <section className="shr-section" aria-labelledby="share-viewing-heading">
                <h4 id="share-viewing-heading" className="shr-section-title">
                  Viewing now
                </h4>
                <ul className="shr-viewers">
                  {viewers.map((viewer) => (
                    <li key={viewer.id} className="shr-viewer">
                      <span className="shr-viewer-dot" style={{ background: viewer.color }} aria-hidden="true" />
                      {viewer.name}
                      {viewer.isYou && <span className="shr-you">you</span>}
                      {viewer.active === false && <span className="shr-hint"> · inactive</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </div>

      {sharing && resource && (
        <ShareDialog
          open={granting}
          onClose={() => setGranting(false)}
          scopes={sharing.scopes.slice(sharing.scopes.indexOf(resource))}
          candidates={sharing.candidates}
          capabilities={sharing.capabilities}
          context={sharing.context}
          actor={sharing.actor}
          onGrant={sharing.onGrant}
          ceiling={SHARING_CEILING}
          ceilingReason={SHARING_CEILING_REASON}
          nameOf={sharing.nameOf}
        />
      )}

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
        onGrant={async (pending) => {
          const granted = await members.admit(pending)
          // Reported rather than awaited: covering a notebook's worth of notes
          // is what makes the grant useful, and blocking on it would look broken.
          if (granted && encryptedSyncEnabled()) void admission.cover(pending.redemption.did, granted.epoch)
        }}
        onReject={members.reject}
      />
    </>
  )
}

export default ShareAccessDialog
