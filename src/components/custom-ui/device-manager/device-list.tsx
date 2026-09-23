"use client"

import * as React from "react"
import {
  RiComputerLine,
  RiSmartphoneLine,
  RiShieldCheckLine,
  RiLinkUnlink,
} from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { useFingerprints } from "@/hooks/use-device-identity"
import { memberOf, type MemberDevice } from "@/lib/identity"

import "./device-manager.scss"

export type DeviceListProps = {
  devices: readonly MemberDevice[]
  /** `did:key` of the device the person is looking at right now. */
  currentDid?: string
  /** Omitted when the viewer has no way to revoke - a linked device, say. */
  onRevoke?: (device: MemberDevice) => void
  className?: string
}

function deviceLabel(device: MemberDevice): string {
  return device.kind === "admitted" ? device.admission.label : memberOf(device)
}

function formatAdded(device: MemberDevice): string {
  const at = device.kind === "admitted" ? device.admission.issuedAt : device.link.issuedAt
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * The member's devices.
 *
 * Two things are deliberately visible rather than tucked away. The *kind* of
 * each device, because an admin-admitted one and a self-linked one are not
 * interchangeable - only the former can approve a new device, and a member with
 * none left cannot add devices at all. And the fingerprint, because it is the
 * only way to tell two devices apart when both are called "Laptop".
 */
export function DeviceList({ devices, currentDid, onRevoke, className }: DeviceListProps) {
  const fingerprints = useFingerprints(React.useMemo(() => devices.map((d) => d.record.did), [devices]))

  if (devices.length === 0) {
    return (
      <p className="dm-empty" role="status">
        No devices yet. This device will appear here once it has been admitted.
      </p>
    )
  }

  return (
    <ul className={["dm-device-list", className ?? ""].join(" ")} aria-label="Your devices">
      {devices.map((device) => {
        const did = device.record.did
        const isCurrent = did === currentDid
        const admitted = device.kind === "admitted"

        return (
          <li key={did} className={["dm-device", isCurrent ? "is-current" : ""].join(" ")}>
            <span className="dm-device-icon" aria-hidden="true">
              {admitted ? <RiComputerLine /> : <RiSmartphoneLine />}
            </span>

            <span className="dm-device-main">
              <span className="dm-device-name">
                {deviceLabel(device)}
                {isCurrent && <span className="dm-badge dm-badge-current">This device</span>}
              </span>

              <span className="dm-device-meta">
                <span
                  className={["dm-badge", admitted ? "dm-badge-admitted" : "dm-badge-linked"].join(
                    " ",
                  )}
                  title={
                    admitted
                      ? "Admitted by an admin. Can approve new devices."
                      : "Added by one of your own devices. Cannot approve new devices."
                  }
                >
                  {admitted ? (
                    <>
                      <RiShieldCheckLine aria-hidden="true" /> Admin-approved
                    </>
                  ) : (
                    "Linked by you"
                  )}
                </span>
                <span className="dm-device-added">Added {formatAdded(device)}</span>
              </span>

              <code className="dm-fingerprint" aria-label={`Fingerprint for ${deviceLabel(device)}`}>
                {fingerprints[did] ?? "…"}
              </code>
            </span>

            {onRevoke && !isCurrent && (
              <Button
                type="button"
                data-style="ghost"
                aria-label={`Remove ${deviceLabel(device)}`}
                tooltip="Remove this device"
                onClick={() => onRevoke(device)}
              >
                <RiLinkUnlink className="tiptap-button-icon" />
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default DeviceList
