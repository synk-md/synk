/**
 * Connection and sync state, named from the person's point of view rather than
 * the transport's. The distinction that matters is saved versus shared.
 */

export type ConnectionState = "offline" | "connecting" | "online"

/** Which route is carrying traffic. `peer` is the degraded-but-working case. */
export type Route = "relay" | "peer" | "none"

export type SyncPhase = "caught-up" | "syncing" | "offline-pending" | "offline-idle"

export interface SyncStatus {
  connection: ConnectionState
  route: Route
  phase: SyncPhase
  /** Envelopes authored here that no transport has accepted yet. */
  pendingOutbound: number
  /** Last successful two-way catch-up. Null when it has never happened. */
  lastSyncedAt: number | null
  lastError: string | null
}

export function initialStatus(): SyncStatus {
  return {
    connection: "offline",
    route: "none",
    phase: "offline-idle",
    pendingOutbound: 0,
    lastSyncedAt: null,
    lastError: null,
  }
}

/**
 * Derived, so no caller can assemble "caught up" while offline with work
 * pending - the reassuring lie this surface exists to avoid.
 */
export function derivePhase(
  connection: ConnectionState,
  pendingOutbound: number,
  inFlight: boolean,
): SyncPhase {
  if (connection !== "online") return pendingOutbound > 0 ? "offline-pending" : "offline-idle"
  if (inFlight || pendingOutbound > 0) return "syncing"
  return "caught-up"
}

export type StatusListener = (status: SyncStatus) => void

/** Outside React, so transports can report in without knowing a component exists. */
export class SyncStatusTracker {
  private status: SyncStatus = initialStatus()
  private readonly listeners = new Set<StatusListener>()
  private inFlight = 0

  get current(): SyncStatus {
    return this.status
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  private emit(next: Partial<SyncStatus>): void {
    const merged = { ...this.status, ...next }
    merged.phase = derivePhase(merged.connection, merged.pendingOutbound, this.inFlight > 0)
    // A status line that flickers is one people stop reading.
    if (
      merged.connection === this.status.connection &&
      merged.route === this.status.route &&
      merged.phase === this.status.phase &&
      merged.pendingOutbound === this.status.pendingOutbound &&
      merged.lastSyncedAt === this.status.lastSyncedAt &&
      merged.lastError === this.status.lastError
    ) {
      return
    }
    this.status = merged
    for (const listener of this.listeners) listener(merged)
  }

  setConnection(connection: ConnectionState): void {
    this.emit({ connection })
  }

  setRoute(route: Route): void {
    this.emit({ route })
  }

  setPending(pendingOutbound: number): void {
    this.emit({ pendingOutbound })
  }

  /** Wrap a sync attempt so the phase reflects work actually in flight. */
  async track<T>(work: () => Promise<T>, now: () => number = Date.now): Promise<T> {
    this.inFlight += 1
    this.emit({})
    try {
      const result = await work()
      this.inFlight -= 1
      this.emit({ lastSyncedAt: now(), lastError: null })
      return result
    } catch (error) {
      this.inFlight -= 1
      this.emit({ lastError: error instanceof Error ? error.message : "Sync failed" })
      throw error
    }
  }
}
