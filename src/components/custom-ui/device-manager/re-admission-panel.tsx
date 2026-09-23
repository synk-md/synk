"use client"

import * as React from "react"
import { RiLifebuoyLine, RiFileCopyLine, RiCheckLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"

import "./device-manager.scss"

export type ReAdmissionPanelProps = {
  /** This device's fingerprint - what an admin needs in order to admit it. */
  fingerprint: string | null
  /** This device's full `did:key`, for an admin to paste in. */
  did: string | null
  /** Where to send the request, if the app has a channel for it. */
  onRequest?: () => void
  className?: string
}

/**
 * Getting back in after losing every device.
 *
 * There is no recovery here and there cannot be: the signing key is
 * non-extractable, so nothing was ever backed up, which is the same property
 * that stops a compromised page exfiltrating it. Re-admission is the path, and
 * this panel exists so that is discoverable rather than a dead end.
 *
 * It shows what an admin actually needs - this device's fingerprint and DID -
 * because the realistic flow is a person reading a code to a colleague, not a
 * button that reaches a server the person can no longer authenticate to.
 */
export function ReAdmissionPanel({ fingerprint, did, onRequest, className }: ReAdmissionPanelProps) {
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    if (!did) return
    try {
      await navigator.clipboard.writeText(did)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused; the DID is on screen to read anyway.
      setCopied(false)
    }
  }

  return (
    <section className={["dm-readmission", className ?? ""].join(" ")} aria-labelledby="dm-readmission-heading">
      <div className="dm-readmission-header">
        <span className="dm-warning-icon" aria-hidden="true">
          <RiLifebuoyLine />
        </span>
        <h4 id="dm-readmission-heading">Lost all your devices?</h4>
      </div>

      <p className="dm-body-text">
        There is no way to recover an old device&rsquo;s key — it never leaves the device it was
        made on, which is what stops anyone else taking it. Instead, an admin admits this device as
        a new one.
      </p>

      <p className="dm-body-text dm-muted">
        Your notes stay encrypted to the keys you had, so history from before you lost access will
        not come back with you.
      </p>

      <div className="dm-field-label">Give your admin this code</div>
      <div className="dm-fingerprint-display" aria-label="This device's fingerprint">
        <code>{fingerprint ?? "…"}</code>
      </div>

      <div className="dm-readmission-actions">
        <Button data-style="ghost" onClick={() => void copy()} disabled={!did}>
          {copied ? (
            <>
              <RiCheckLine className="tiptap-button-icon" />
              <span className="tiptap-button-text">Copied</span>
            </>
          ) : (
            <>
              <RiFileCopyLine className="tiptap-button-icon" />
              <span className="tiptap-button-text">Copy full device ID</span>
            </>
          )}
        </Button>
        {onRequest && (
          <Button className="dm-primary-btn is-active" onClick={onRequest}>
            <span className="tiptap-button-text">Request re-admission</span>
          </Button>
        )}
      </div>
    </section>
  )
}

export default ReAdmissionPanel
