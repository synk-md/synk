"use client"

import * as React from "react"
import { RiComputerLine, RiLinkUnlink, RiShieldCheckLine, RiSmartphoneLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { useFingerprints } from "@/hooks/use-device-identity"
import { type MemberDevice } from "@/lib/identity"

import { canRevokeLink } from "./membership-model"

import "./membership.scss"

export type LinkRevocationRequest = {
  device: MemberDevice & { kind: "linked" }
  reason?: string
}

export type DeviceRevocationProps = {
  devices: readonly MemberDevice[]
  /** The device this person is acting from. Entitlement is judged against it. */
  actingDid: string
  /** Member the devices belong to, for the entitlement check. */
  member: string
  onRevokeLink: (request: LinkRevocationRequest) => Promise<void> | void
  className?: string
}

/**
 * Invalidating a device.
 *
 * The case this exists for is a lost phone. A member can do it from their
 * laptop without an admin, because the self-service path that created the link
 * should be able to undo it.
 *
 * Only linked devices appear with a revoke control. Removing an admin-admitted
 * device is a membership change, not a device change - it is what strands a
 * member from adding devices at all - so it is not quietly offered next to
 * unlinking a phone.
 *
 * Unlinking does **not** rotate the content key. That is a real limit, not a
 * simplification, and it is stated rather than glossed: the lost phone keeps
 * the key it already holds and can still read anything sealed under the current
 * epoch. What changes is that its writes stop being accepted. Removing the
 * member outright is the operation that rotates, and the interface says so,
 * because somebody unlinking a stolen phone is entitled to know which of the
 * two they have just done.
 */
export function DeviceRevocation({
  devices,
  actingDid,
  member,
  onRevokeLink,
  className,
}: DeviceRevocationProps) {
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const fingerprints = useFingerprints(
    React.useMemo(() => devices.map((device) => device.record.did), [devices]),
  )

  const revoke = async (device: MemberDevice & { kind: "linked" }) => {
    setBusy(device.record.did)
    setError(null)
    try {
      await onRevokeLink({ device })
      setConfirming(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not unlink that device.")
    } finally {
      setBusy(null)
    }
  }

  if (devices.length === 0) {
    return (
      <p className="mb-empty" role="status">
        No devices on record for this member.
      </p>
    )
  }

  return (
    <ul className={["mb-device-list", className ?? ""].join(" ")} aria-label="Devices">
      {devices.map((device) => {
        const did = device.record.did
        const admitted = device.kind === "admitted"
        const entitled = !admitted && canRevokeLink(devices, actingDid, member, did)
        const isActing = did === actingDid

        return (
          <li key={did} className={["mb-device", isActing ? "is-current" : ""].join(" ")}>
            <span className="mb-device-icon" aria-hidden="true">
              {admitted ? <RiComputerLine /> : <RiSmartphoneLine />}
            </span>

            <span className="mb-device-main">
              <span className="mb-device-name">
                {admitted ? device.admission.label : "Linked device"}
                {isActing && <span className="mb-chip">This device</span>}
              </span>
              <span className="mb-device-meta">
                <span
                  className={["mb-chip", admitted ? "is-admitted" : "is-linked"].join(" ")}
                  title={
                    admitted
                      ? "Admitted by an admin. Can approve and unlink other devices."
                      : "Added by one of this member's own devices. Cannot approve or unlink anything."
                  }
                >
                  {admitted ? <RiShieldCheckLine aria-hidden="true" /> : <RiLinkUnlink aria-hidden="true" />}
                  {admitted ? "Admin-admitted" : "Self-linked"}
                </span>
                <code className="mb-fingerprint">{fingerprints[did] ?? "…"}</code>
              </span>

              {confirming === did && device.kind === "linked" && (
                <span className="mb-confirm" role="alert">
                  <strong>Unlink this device?</strong>
                  <span className="mb-note">
                    Its edits stop being accepted elsewhere as the withdrawal spreads. It keeps the
                    content key it already holds, so it can still read what is sealed under the
                    current key — if the device was stolen, remove the member instead. That
                    replaces the key.
                  </span>
                  <span className="mb-inline-actions">
                    <Button data-style="ghost" onClick={() => setConfirming(null)}>
                      <span className="tiptap-button-text">Keep it</span>
                    </Button>
                    <Button
                      className="mb-danger-btn"
                      disabled={busy === did}
                      onClick={() => void revoke(device)}
                    >
                      <span className="tiptap-button-text">
                        {busy === did ? "Unlinking…" : "Unlink"}
                      </span>
                    </Button>
                  </span>
                </span>
              )}
            </span>

            {admitted ? (
              <span className="mb-note mb-device-note">
                Removing this is a membership change, not a device change.
              </span>
            ) : (
              confirming !== did && (
                <Button
                  data-style="ghost"
                  disabled={!entitled}
                  aria-label={`Unlink ${fingerprints[did] ?? did}`}
                  tooltip={
                    entitled
                      ? undefined
                      : isActing
                        ? "A linked device cannot unlink itself. Use an admin-admitted device."
                        : "Only an admin-admitted device of this member can unlink it."
                  }
                  onClick={() => setConfirming(did)}
                >
                  <span className="tiptap-button-text">Unlink</span>
                </Button>
              )
            )}
          </li>
        )
      })}

      {error && (
        <li className="mb-error" role="alert">
          {error}
        </li>
      )}
    </ul>
  )
}

export default DeviceRevocation
