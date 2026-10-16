"use client"

import * as React from "react"
import { RiAlertLine, RiKey2Line } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"

import "@/components/custom-ui/sharing/sharing.scss"

export type RecoveryCodeDialogProps = {
  code: string
  /** "new": a notebook was just created. "next": a recovery just used the old code up. */
  reason: "new" | "next"
  onDone: () => void
}

/**
 * The recovery code, shown once. It is not kept on this device, so there is no
 * second look: saving it is the person's, and the dialog will not close until
 * they say they have.
 */
export function RecoveryCodeDialog({ code, reason, onDone }: RecoveryCodeDialogProps) {
  const [saved, setSaved] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="shr-backdrop">
      <div className="shr-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-code-heading">
        <div className="shr-header">
          <div className="shr-heading">
            <h3 id="recovery-code-heading">
              <RiKey2Line aria-hidden="true" /> {reason === "new" ? "Save this notebook's recovery code" : "Save the new recovery code"}
            </h3>
          </div>
        </div>
        <p className="shr-hint">
          {reason === "new"
            ? "If every device you use this notebook on is lost, this code gives it back to you - control of it, and everything written in it. It is shown only now, and kept nowhere."
            : "The old code has been used and no longer works. This one replaces it. It is shown only now, and kept nowhere."}
        </p>
        <div className="shr-link-row">
          <input readOnly value={code} aria-label="Recovery code" onFocus={(event) => event.currentTarget.select()} />
          <Button type="button" onClick={copy}>
            <span className="tiptap-button-text">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <div className="shr-warning" role="note">
          <span className="shr-warning-icon" aria-hidden="true">
            <RiAlertLine />
          </span>
          <div>
            <strong>Whoever has this code can take the notebook and read all of it.</strong>
            <p>Keep it somewhere safe and apart from your devices - a password manager, or on paper.</p>
          </div>
        </div>
        <label className="shr-check">
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
          <span className="shr-check-label">I have saved it somewhere safe</span>
        </label>
        <div className="shr-actions">
          <Button className={["shr-primary-btn", saved ? "is-active" : ""].join(" ")} disabled={!saved} onClick={onDone}>
            <span className="tiptap-button-text">Done</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default RecoveryCodeDialog
