// src/components/tiptap-ui/collaboration-status-menu/use-collaboration-status-menu.ts
"use client"

import * as React from "react"

export type ActiveUser = {
  id: string
  name: string
  isYou?: boolean
  color?: string
  active?: boolean
  lastActiveAt?: Date
}

export interface UseCollaborationStatusMenuConfig {
  users?: ActiveUser[]
  /** Hide the trigger entirely if there are no users */
  hideWhenEmpty?: boolean
  /** Label shown on the trigger button */
  label?: string
}

function sortUsers(a: ActiveUser, b: ActiveUser) {
  // Active first, "you" next, then name
  const aActive = a.active !== false
  const bActive = b.active !== false
  if (aActive !== bActive) return aActive ? -1 : 1
  if ((a.isYou ? 1 : 0) !== (b.isYou ? 1 : 0)) return a.isYou ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

export function useCollaborationStatusMenu(
  config?: UseCollaborationStatusMenuConfig
) {
  const {
    users: providedUsers = [],
    hideWhenEmpty = false,
    label = "Collab",
  } = config || {}

  // Memoize sorted/derived state
  const users = React.useMemo(
    () => [...providedUsers].sort(sortUsers),
    [providedUsers]
  )

  const activeUsers = React.useMemo(
    () => users.filter(u => u.active !== false),
    [users]
  )

  const activeCount = activeUsers.length
  const totalCount = users.length

  const isVisible = !hideWhenEmpty || totalCount > 0

  const ariaLabel = `${label}: ${activeCount} active${totalCount > activeCount ? ` of ${totalCount}` : ""}`

  return {
    // data
    users,
    activeUsers,
    activeCount,
    totalCount,
    // ui helpers
    label,
    ariaLabel,
    isVisible,
  }
}
