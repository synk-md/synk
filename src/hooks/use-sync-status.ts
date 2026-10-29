import * as React from "react"
import type { WebrtcProvider } from "y-webrtc"
import { probeProvider, SyncStatusTracker, type SyncState } from "@/lib/sync-status"

const POLL_MS = 1_000
const OFFLINE: SyncState = { status: "offline", peerCount: 0 }

// Polled because y-webrtc emits nothing when a peer link or signaling socket
// opens. The tracker outlives provider swaps so watchdog reconnects still
// count towards "failed"; it resets per scopeKey (i.e. per note).
export function useSyncStatus(
  providerRef: React.RefObject<WebrtcProvider | null>,
  providerReady: boolean,
  providerGeneration: number,
  scopeKey: string | null,
): SyncState {
  const trackerRef = React.useRef<{ scopeKey: string; tracker: SyncStatusTracker } | null>(null)
  const [state, setState] = React.useState<SyncState>(OFFLINE)

  React.useEffect(() => {
    const provider = providerReady && scopeKey ? providerRef.current : null
    if (!provider || !scopeKey) {
      setState(OFFLINE)
      return
    }

    if (trackerRef.current?.scopeKey !== scopeKey) {
      trackerRef.current = { scopeKey, tracker: new SyncStatusTracker() }
    }
    const { tracker } = trackerRef.current
    tracker.attach(provider, Date.now())

    const update = () => {
      const next = tracker.next(probeProvider(provider), Date.now())
      setState(prev => (prev.status === next.status && prev.peerCount === next.peerCount ? prev : next))
    }
    update()
    const interval = setInterval(update, POLL_MS)
    provider.on("peers", update)
    provider.on("synced", update)
    return () => {
      clearInterval(interval)
      provider.off("peers", update)
      provider.off("synced", update)
    }
  }, [providerRef, providerReady, providerGeneration, scopeKey])

  return state
}
