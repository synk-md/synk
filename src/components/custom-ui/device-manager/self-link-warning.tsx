"use client"

import { RiAlertLine, RiErrorWarningLine } from "@remixicon/react"

import type { MemberDevice, User } from "@/lib/identity"

import { selfLinkStatus } from "./self-link-status"

import "./device-manager.scss"

export type SelfLinkWarningProps = {
  user: User
  /** The device about to be removed, if this is a pre-removal check. */
  removing?: MemberDevice
  className?: string
}

/**
 * The warning shown before a member can strand themselves.
 *
 * Deliberately graded rather than a single alarm. "This is your last one" is
 * advice; "this would strand you" is a consequence, and the difference matters
 * because only the second is irreversible without someone else's help.
 */
export function SelfLinkWarning({ user, removing, className }: SelfLinkWarningProps) {
  const status = selfLinkStatus(user, removing)

  // Two or more admin-approved devices: nothing to warn about.
  if (status.level === "ok") return null

  const stranded = status.level === "stranded"

  return (
    <div
      className={[
        "dm-warning",
        stranded ? "is-critical" : "is-caution",
        className ?? "",
      ].join(" ")}
      role={stranded ? "alert" : "status"}
    >
      <span className="dm-warning-icon" aria-hidden="true">
        {stranded ? <RiErrorWarningLine /> : <RiAlertLine />}
      </span>
      <div className="dm-warning-body">
        {stranded ? (
          <>
            <strong>This would lock you out of adding devices.</strong>
            <p>
              {removing ? "Removing this device leaves" : "You have"} no admin-approved devices.
              Devices you linked yourself cannot approve new ones, so you would need an admin to
              let you back in.
            </p>
          </>
        ) : (
          <>
            <strong>This is your only admin-approved device.</strong>
            <p>
              Only admin-approved devices can approve a new one. If you lose this device, adding
              another will need an admin.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default SelfLinkWarning
