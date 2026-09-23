"use client"

import { RiCloudOffLine } from "@remixicon/react"

import type { SyncStatus } from "@/lib/relay"

import { offlineReason } from "./sync-copy"

import "./connection.scss"

export type OfflineBannerProps = {
  status: SyncStatus
  browserOnline?: boolean
  onDismiss?: () => void
  className?: string
}

/**
 * Reassurance for someone offline long enough to wonder. Not an error and not
 * red: dressing a supported state as a fault teaches people to distrust an app
 * that is working.
 *
 * Only when something is waiting - a banner that is always there is unread.
 */
export function OfflineBanner({ status, browserOnline = true, onDismiss, className }: OfflineBannerProps) {
  if (status.phase !== "offline-pending") return null

  const count = status.pendingOutbound

  return (
    <div className={["cx-banner", className ?? ""].join(" ")} role="status">
      <span className="cx-banner-icon" aria-hidden="true">
        <RiCloudOffLine />
      </span>
      <div className="cx-banner-body">
        <strong>
          Working offline — {count === 1 ? "1 change is" : `${String(count)} changes are`} waiting to
          be shared.
        </strong>
        <span>
          {offlineReason(browserOnline)} Everything you write is saved on this device and will sync
          when a connection returns.
        </span>
      </div>
      {onDismiss && (
        <button type="button" className="cx-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}

export default OfflineBanner
