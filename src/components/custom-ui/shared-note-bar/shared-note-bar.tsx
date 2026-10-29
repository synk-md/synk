import * as React from "react"
import { RiEdit2Line, RiEyeLine, RiLock2Line } from "@remixicon/react"

import { Avatar, PresenceDot, type ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"

import type { SyncStatus } from "@/lib/sync-status"

import "./shared-note-bar.scss"

export type { SyncStatus }
export type SharedPermission = "edit" | "view" | "revoked"

export interface SharedNoteBarProps {
  ownerName?: string
  users: ActiveUser[]
  syncStatus: SyncStatus
  permission: SharedPermission
  peerCount?: number
  lastSyncedAt?: Date | null
  /** Renders inline inside a toolbar row (flex:1, no fixed height). */
  embedded?: boolean
}


const permissionLabel: Record<SharedPermission, string> = {
  edit: "Can edit",
  view: "View only",
  revoked: "No longer shared",
}

const permissionIcon: Record<SharedPermission, typeof RiEdit2Line> = {
  edit: RiEdit2Line,
  view: RiEyeLine,
  revoked: RiLock2Line,
}

const getInitials = (name: string) => {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? "").join("")
}

function formatLastSynced(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const syncLabel: Record<SyncStatus, string> = {
  offline: "Offline",
  connecting: "Connecting…",
  waiting: "Waiting for others",
  live: "Synced",
  failed: "Can't connect to peers",
  unreachable: "Sync server unreachable",
}

const syncHint: Partial<Record<SyncStatus, string>> = {
  waiting: "No one else has this note open on another device right now.",
  failed: "Someone else has this note open, but your networks blocked a direct connection. Your edits are saved on this device.",
  unreachable: "Can't reach the sync server, so other devices can't find you. Your edits are saved on this device.",
}

export interface SyncStatusIndicatorProps {
  syncStatus: SyncStatus
  /** Peers this note is actively synced with. */
  peerCount?: number
  lastSyncedAt?: Date | null
}

export function SyncStatusIndicator({ syncStatus, peerCount = 0, lastSyncedAt }: SyncStatusIndicatorProps) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!lastSyncedAt || syncStatus === "live") return
    const id = setInterval(() => setTick(t => t + 1), 5_000)
    return () => clearInterval(id)
  }, [lastSyncedAt, syncStatus])

  const label = syncStatus === "live"
    ? `Synced with ${peerCount} ${peerCount === 1 ? "other" : "others"}`
    : syncLabel[syncStatus]
  const showLastSynced = (syncStatus === "waiting" || syncStatus === "offline") && lastSyncedAt

  return (
    <span
      className={`shared-note-bar__sync shared-note-bar__sync--${syncStatus}`}
      role="status"
      aria-label={`Sync status: ${label}`}
      title={syncHint[syncStatus]}
    >
      <PresenceDot active={syncStatus === "live"} />
      {label}
      {showLastSynced && (
        <span className="shared-note-bar__sync-time">
          · last synced {formatLastSynced(lastSyncedAt)}
        </span>
      )}
    </span>
  )
}

export function SharedNoteBar({
  ownerName,
  users,
  syncStatus,
  permission,
  peerCount,
  lastSyncedAt,
  embedded = false,
}: SharedNoteBarProps) {
  const PermissionIcon = permissionIcon[permission]

  const visibleUsers = users.filter(u => !u.isYou)

  return (
    <div className={`shared-note-bar${embedded ? " shared-note-bar--embedded" : ""}`}>
      <div className="shared-note-bar__provenance">
        {!embedded && <span className="shared-note-bar__provenance-tag">Shared note</span>}
        {ownerName && !embedded && <span className="shared-note-bar__provenance-divider" />}
        {ownerName && !embedded && (
          <span className="shared-note-bar__provenance-owner">
            <span
              className="avatar-bubble"
              style={{ width: "24px", height: "24px"}}
              aria-hidden
            >
              {getInitials(ownerName)}
            </span> 
            from {ownerName}
          </span>
        )}
      </div>

      <div className="shared-note-bar__right">
        <SyncStatusIndicator syncStatus={syncStatus} peerCount={peerCount} lastSyncedAt={lastSyncedAt} />

        {visibleUsers.length > 0 && (
          <div className="shared-note-bar__avatars" aria-label="Active collaborators">
            {visibleUsers.map(u => (
              <Avatar key={u.id} name={u.name} color={u.color} />
            ))}
          </div>
        )}

        <span className={`shared-note-bar__permission shared-note-bar__permission--${permission}`}>
          <PermissionIcon className="tiptap-button-icon" />
          {permissionLabel[permission]}
        </span>
      </div>
    </div>
  )
}

export default SharedNoteBar
