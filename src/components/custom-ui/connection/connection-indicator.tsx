"use client"

import * as React from "react"
import {
  RiCheckLine,
  RiCloudOffLine,
  RiLoader4Line,
  RiRefreshLine,
  RiShieldCheckLine,
  RiWifiOffLine,
} from "@remixicon/react"

import type { SyncStatus } from "@/lib/relay"

import { LOCAL_FIRST_NOTE, offlineReason, statusCopy, type StatusTone } from "./sync-copy"

import "./connection.scss"

export type ConnectionIndicatorProps = {
  status: SyncStatus
  /** `navigator.onLine`. Explains why, never decides whether. */
  browserOnline?: boolean
  expanded?: boolean
  onRetry?: () => void
  now?: number
  className?: string
}

const ICON: Record<StatusTone, React.ReactNode> = {
  ok: <RiCheckLine />,
  busy: <RiLoader4Line />,
  waiting: <RiCloudOffLine />,
  trouble: <RiWifiOffLine />,
}

function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${String(minutes)} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? "1 hour ago" : `${String(hours)} hours ago`
}

/**
 * Connection and sync state, present always rather than only when something is
 * wrong - an indicator that appears only on failure teaches people its absence
 * means nothing, and then its presence means panic.
 */
export function ConnectionIndicator({
  status,
  browserOnline = true,
  expanded = false,
  onRetry,
  now = Date.now(),
  className,
}: ConnectionIndicatorProps) {
  const copy = statusCopy(status)
  const offline = status.phase === "offline-idle" || status.phase === "offline-pending"
  const reason = offline ? offlineReason(browserOnline) : null

  return (
    <div
      className={["cx-indicator", `is-${copy.tone}`, expanded ? "is-expanded" : "", className ?? ""].join(" ")}
      // Live, so the state reaches a screen reader without focus on the chip.
      role="status"
      aria-live="polite"
    >
      <span className="cx-chip" title={expanded ? undefined : `${copy.label}. ${copy.detail}`}>
        <span className={["cx-icon", copy.tone === "busy" ? "is-spinning" : ""].join(" ")} aria-hidden="true">
          {ICON[copy.tone]}
        </span>
        <span className="cx-label">{copy.label}</span>
        {status.pendingOutbound > 0 && (
          <span className="cx-count" aria-label={`${String(status.pendingOutbound)} changes waiting`}>
            {status.pendingOutbound}
          </span>
        )}
      </span>

      {expanded && (
        <div className="cx-detail">
          <p className="cx-detail-line">{copy.detail}</p>

          {reason && <p className="cx-reason">{reason}</p>}

          {status.lastSyncedAt !== null && (
            <p className="cx-meta">Last shared {ago(status.lastSyncedAt, now)}.</p>
          )}
          {status.lastSyncedAt === null && !offline && (
            <p className="cx-meta">Nothing has been shared from this device yet.</p>
          )}

          <p className="cx-note">
            <RiShieldCheckLine aria-hidden="true" /> {LOCAL_FIRST_NOTE}
          </p>

          {offline && onRetry && (
            <button type="button" className="cx-retry" onClick={onRetry}>
              <RiRefreshLine aria-hidden="true" />
              Try reconnecting
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ConnectionIndicator
