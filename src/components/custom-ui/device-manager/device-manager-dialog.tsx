"use client"

import * as React from "react"
import { RiCloseLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { useDeviceIdentity } from "@/hooks/use-device-identity"
import { userLabel, type MemberDevice, type User } from "@/lib/identity"

import { DeviceList } from "./device-list"
import { ReAdmissionPanel } from "./re-admission-panel"
import { selfLinkStatus } from "./self-link-status"
import { SelfLinkWarning } from "./self-link-warning"

import "./device-manager.scss"

export type DeviceManagerDialogProps = {
  open: boolean
  onClose: () => void
  user: User
  onRevoke?: (device: MemberDevice) => Promise<void> | void
  canRevoke?: (device: MemberDevice) => boolean
  /** What removing actually does here, which depends on who can replace the key. */
  removalNote?: string
  onRequestReAdmission?: () => void
  /** More about these devices, below the list. */
  children?: React.ReactNode
  className?: string
}

/**
 * Your devices, in one place.
 *
 * Removal asks for confirmation only when it matters. Removing one of several
 * admin-approved devices is routine and gets a plain confirm; removing the last
 * one is shown with the consequence spelled out, because it is the step that
 * cannot be undone without an admin.
 */
export function DeviceManagerDialog({
  open,
  onClose,
  user,
  onRevoke,
  canRevoke,
  removalNote,
  onRequestReAdmission,
  children,
  className,
}: DeviceManagerDialogProps) {
  const { identity, fingerprint } = useDeviceIdentity()
  const [pendingRemoval, setPendingRemoval] = React.useState<MemberDevice | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setPendingRemoval(null)
      setBusy(false)
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      if (pendingRemoval) setPendingRemoval(null)
      else onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose, pendingRemoval])

  if (!open) return null

  const label = userLabel(user)
  const confirmRemoval = async () => {
    if (!pendingRemoval || busy) return
    setBusy(true)
    try {
      await onRevoke?.(pendingRemoval)
      setPendingRemoval(null)
    } finally {
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
        className={["dm-dialog dm-dialog-wide", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dm-heading"
      >
        <div className="dm-header">
          <div className="dm-heading">
            <h3 id="dm-heading">Your devices</h3>
            {label.status === "attested" && <span className="dm-subtle">{label.label}</span>}
            {label.status === "conflicted" && (
              <span className="dm-subtle dm-conflicted" title={label.labels.join(" / ")}>
                Name not agreed
              </span>
            )}
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <SelfLinkWarning user={user} />

        <DeviceList
          devices={user.devices}
          {...(identity ? { currentDid: identity.did } : {})}
          {...(onRevoke ? { onRevoke: setPendingRemoval } : {})}
          {...(canRevoke ? { canRevoke } : {})}
        />

        {children}

        {pendingRemoval && (
          <div className="dm-confirm" role="alertdialog" aria-label="Confirm removal">
            <SelfLinkWarning user={user} removing={pendingRemoval} />
            <p className="dm-body-text">
              {removalNote ?? "Remove this device? It will stop being able to read anything written from now on."}
            </p>
            <div className="dm-actions">
              <Button data-style="ghost" onClick={() => setPendingRemoval(null)}>
                <span className="tiptap-button-text">Keep it</span>
              </Button>
              <Button
                className={[
                  "dm-primary-btn is-active",
                  selfLinkStatus(user, pendingRemoval).level === "stranded" ? "is-danger" : "",
                ].join(" ")}
                disabled={busy}
                onClick={() => void confirmRemoval()}
              >
                <span className="tiptap-button-text">{busy ? "Removing…" : "Remove device"}</span>
              </Button>
            </div>
          </div>
        )}

        <ReAdmissionPanel
          fingerprint={fingerprint}
          did={identity?.did ?? null}
          {...(onRequestReAdmission ? { onRequest: onRequestReAdmission } : {})}
        />
      </div>
    </div>
  )
}

export default DeviceManagerDialog
