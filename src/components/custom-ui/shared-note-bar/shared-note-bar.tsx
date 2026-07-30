import * as React from "react"
import { RiEdit2Line, RiEyeLine, RiLock2Line } from "@remixicon/react"

import { Avatar, PresenceDot, type ActiveUser } from "@/components/custom-ui/collaboration-dropdown-menu"

import "./shared-note-bar.scss"

export type SyncStatus = "offline" | "connecting" | "live"
export type SharedPermission = "edit" | "view" | "revoked"

export interface SharedNoteBarProps {
  ownerName?: string
  users: ActiveUser[]
  syncStatus: SyncStatus
  permission: SharedPermission
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

export interface SyncStatusIndicatorProps {
  syncStatus: SyncStatus
  lastSyncedAt?: Date | null
}

export function SyncStatusIndicator({ syncStatus, lastSyncedAt }: SyncStatusIndicatorProps) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!lastSyncedAt || syncStatus === "live") return
    const id = setInterval(() => setTick(t => t + 1), 5_000)
    return () => clearInterval(id)
  }, [lastSyncedAt, syncStatus])

  return (
    <span
      className={`shared-note-bar__sync${syncStatus === "live" ? " shared-note-bar__sync--live" : ""}`}
      aria-label={`Sync status: ${syncStatus === "connecting" ? "Connecting" : "Synced"}`}
    >
      <PresenceDot active={syncStatus === "live"} />
      {syncStatus === "connecting" ? "Connecting…" : "Synced"}
      {syncStatus !== "connecting" && lastSyncedAt && (
        <span className="shared-note-bar__sync-time">
          · {formatLastSynced(lastSyncedAt)}
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
        <SyncStatusIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} />

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
