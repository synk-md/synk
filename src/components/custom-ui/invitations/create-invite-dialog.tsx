"use client"

import * as React from "react"
import {
  RiCloseLine,
  RiFileCopyLine,
  RiCheckLine,
  RiLinkM,
  RiKey2Line,
  RiAlertLine,
} from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { generateInvitationSecret, type Invitation } from "@/lib/directory"

import "./invitations.scss"

export type CreateInviteRequest = {
  /** The raw secret. Never leaves this dialog except through the caller. */
  secret: Uint8Array
  member: string
  label: string
}

export type CreateInviteDialogProps = {
  open: boolean
  onClose: () => void
  /** Signs the invitation. The dialog never holds the admin key. */
  onCreate: (request: CreateInviteRequest) => Promise<Invitation>
  /** Where the invitee should go. Must not contain the secret. */
  joinLink: string
  className?: string
}

type Stage = "compose" | "share"

/**
 * Creating an invitation and handing it over. **The link and the secret must
 * travel by different routes** - put both in one message and whoever reads it
 * can join as the invitee.
 *
 * Built into the interface rather than written above it: two distinct copy
 * buttons and never a combined one, the secret withheld until the link has been
 * copied, and guidance naming concrete channels rather than "use a secure
 * channel", which nobody acts on.
 */
export function CreateInviteDialog({
  open,
  onClose,
  onCreate,
  joinLink,
  className,
}: CreateInviteDialogProps) {
  const [stage, setStage] = React.useState<Stage>("compose")
  const [member, setMember] = React.useState("")
  const [label, setLabel] = React.useState("")
  const [secretText, setSecretText] = React.useState<string | null>(null)
  const [invitation, setInvitation] = React.useState<Invitation | null>(null)
  const [copiedLink, setCopiedLink] = React.useState(false)
  const [copiedSecret, setCopiedSecret] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) return
    setStage("compose")
    setMember("")
    setLabel("")
    setSecretText(null)
    setInvitation(null)
    setCopiedLink(false)
    setCopiedSecret(false)
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

  const hasLabel = label.trim().length > 0

  const create = async () => {
    if (!hasLabel || busy) return
    setBusy(true)
    setError(null)
    try {
      const { secret, text } = generateInvitationSecret()
      const created = await onCreate({
        secret,
        member: member.trim() || `member:${label.trim().toLowerCase().replace(/\s+/g, "-")}`,
        label: label.trim(),
      })
      setSecretText(text)
      setInvitation(created)
      setStage("share")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the invitation.")
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, mark: (done: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(value)
      mark(true)
      window.setTimeout(() => mark(false), 2000)
    } catch {
      mark(false)
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
        aria-labelledby="create-invite-heading"
      >
        <div className="inv-header">
          <div className="inv-heading">
            <h3 id="create-invite-heading">
              {stage === "compose" ? "Invite someone" : "Send these separately"}
            </h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        {stage === "compose" ? (
          <>
            <p className="inv-body-text">
              You are vouching for this person. The name you give is the one they will show under —
              they cannot change it themselves.
            </p>

            <label htmlFor="invite-label" className="inv-field-label">
              Their name
            </label>
            <input
              id="invite-label"
              autoFocus
              autoComplete="off"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value)
                if (error) setError(null)
              }}
              placeholder="e.g. Ada Lovelace"
              className={["inv-input", error ? "is-error" : ""].join(" ")}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create()
              }}
            />

            <label htmlFor="invite-member" className="inv-field-label">
              Member id <span className="inv-optional">optional</span>
            </label>
            <input
              id="invite-member"
              autoComplete="off"
              value={member}
              onChange={(event) => setMember(event.target.value)}
              placeholder="derived from the name if left blank"
              className="inv-input"
              disabled={busy}
            />

            {error && (
              <span className="inv-error" role="alert">
                {error}
              </span>
            )}

            <div className="inv-actions">
              <Button data-style="ghost" onClick={onClose}>
                <span className="tiptap-button-text">Cancel</span>
              </Button>
              <Button
                className={["inv-primary-btn", hasLabel ? "is-active" : ""].join(" ")}
                disabled={!hasLabel || busy}
                onClick={() => void create()}
              >
                <span className="tiptap-button-text">
                  {busy ? "Creating…" : "Create invitation"}
                </span>
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="inv-warning" role="note">
              <span className="inv-warning-icon" aria-hidden="true">
                <RiAlertLine />
              </span>
              <div>
                <strong>Send these two things by different routes.</strong>
                <p>
                  Anyone who sees both can join as {invitation?.label ?? "this person"}. Email the
                  link and read the code out on a call, or send the link in chat and the code by
                  text.
                </p>
              </div>
            </div>

            <div className="inv-share-step">
              <span className="inv-step-number" aria-hidden="true">
                1
              </span>
              <div className="inv-share-body">
                <span className="inv-field-label">
                  <RiLinkM aria-hidden="true" /> Joining link
                </span>
                <code className="inv-share-value" aria-label="Joining link">
                  {joinLink}
                </code>
                <p className="inv-hint">Safe to send in the clear. It is only a signpost.</p>
                <Button data-style="ghost" onClick={() => void copy(joinLink, setCopiedLink)}>
                  {copiedLink ? (
                    <>
                      <RiCheckLine className="tiptap-button-icon" />
                      <span className="tiptap-button-text">Copied link</span>
                    </>
                  ) : (
                    <>
                      <RiFileCopyLine className="tiptap-button-icon" />
                      <span className="tiptap-button-text">Copy link</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className={["inv-share-step", copiedLink ? "" : "is-waiting"].join(" ")}>
              <span className="inv-step-number" aria-hidden="true">
                2
              </span>
              <div className="inv-share-body">
                <span className="inv-field-label">
                  <RiKey2Line aria-hidden="true" /> One-time code
                </span>

                {copiedLink ? (
                  <>
                    <code className="inv-share-value inv-secret" aria-label="One-time code">
                      {secretText}
                    </code>
                    <p className="inv-hint">
                      This is the part that proves it is them. Never send it alongside the link.
                    </p>
                    <Button
                      data-style="ghost"
                      onClick={() => void copy(secretText ?? "", setCopiedSecret)}
                    >
                      {copiedSecret ? (
                        <>
                          <RiCheckLine className="tiptap-button-icon" />
                          <span className="tiptap-button-text">Copied code</span>
                        </>
                      ) : (
                        <>
                          <RiFileCopyLine className="tiptap-button-icon" />
                          <span className="tiptap-button-text">Copy code</span>
                        </>
                      )}
                    </Button>
                  </>
                ) : (
                  <p className="inv-hint" role="status">
                    Send the link first — the code is revealed once you have, so the two do not end
                    up in the same message.
                  </p>
                )}
              </div>
            </div>

            <p className="inv-body-text inv-muted">
              The code works once and expires
              {invitation ? ` on ${new Date(invitation.expiresAt).toLocaleDateString()}` : ""}. You
              will still be asked to confirm their device fingerprint before they are let in.
            </p>

            <div className="inv-actions">
              <Button className="inv-primary-btn is-active" onClick={onClose}>
                <span className="tiptap-button-text">Done</span>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default CreateInviteDialog
