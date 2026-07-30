import * as React from "react"
import { RiCloseLine } from "@remixicon/react"
import "./shared-note-bar.scss"

export interface ViewOnlyBannerProps {
  ownerName?: string
  revoked?: boolean
}

export function ViewOnlyBanner({ ownerName, revoked = false }: ViewOnlyBannerProps) {
  const [dismissed, setDismissed] = React.useState(false)

  if (dismissed) return null

  const message = revoked
    ? "This note is no longer shared with you. You're seeing the last version you had access to."
    : `You have view access to this note.${ownerName ? ` Ask ${ownerName}` : " Ask the owner"} for edit access if you'd like to make changes.`

  return (
    <div className="view-only-banner">
      <span>{message}</span>
      <button
        className="view-only-banner__close"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <RiCloseLine />
      </button>
    </div>
  )
}

export default ViewOnlyBanner
