"use client"

import * as React from "react"

import { initialStatus, type SyncStatus, type SyncStatusTracker } from "@/lib/relay"

/**
 * The current sync status. Subscribed rather than polled: these states are
 * short-lived, and a timer would show "syncing" after it finished.
 */
export function useSyncStatus(tracker: SyncStatusTracker | null): SyncStatus {
  const [status, setStatus] = React.useState<SyncStatus>(
    () => tracker?.current ?? initialStatus(),
  )

  React.useEffect(() => {
    if (!tracker) {
      setStatus(initialStatus())
      return
    }
    return tracker.subscribe(setStatus)
  }, [tracker])

  return status
}

/**
 * Only ever a hint, kept separate from the relay's connection state:
 * `navigator.onLine` is true on a captive portal and while the relay is down.
 */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = React.useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  )

  React.useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    return () => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    }
  }, [])

  return online
}
