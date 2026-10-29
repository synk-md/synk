import type { WebrtcProvider } from "y-webrtc"

// y-webrtc's own `connected`/`synced` are true with zero peers, so status is
// derived from its internals instead: signaling sockets and real peer links.
export type SyncStatus = "offline" | "connecting" | "waiting" | "live" | "failed" | "unreachable"

export interface SyncState {
  status: SyncStatus
  peerCount: number
}

export interface PeerProbe {
  id: string
  connected: boolean
  synced: boolean
}

export interface SyncProbe {
  signalingConnected: boolean
  /** A signaling socket has already failed at least one attempt. */
  signalingFailed: boolean
  peers: PeerProbe[]
}

const SIGNALING_GRACE_MS = 5_000
const FAILURE_WINDOW_MS = 30_000
const FAILURES_BEFORE_FAILED = 2

interface SignalingConnLike {
  connected: boolean
  unsuccessfulReconnects: number
}

interface WebrtcConnLike {
  connected: boolean
  synced: boolean
}

export function probeProvider(provider: WebrtcProvider): SyncProbe {
  const signaling = provider.signalingConns as unknown as SignalingConnLike[]
  const conns = (provider.room?.webrtcConns ?? new Map()) as Map<string, WebrtcConnLike>
  return {
    signalingConnected: signaling.some(conn => conn.connected),
    signalingFailed: signaling.some(conn => conn.unsuccessfulReconnects > 0),
    peers: Array.from(conns, ([id, conn]) => ({ id, connected: conn.connected, synced: conn.synced })),
  }
}

// A peer that disappears before ever connecting is a failed handshake, which
// is what a NAT that needs TURN looks like from here.
export class SyncStatusTracker {
  private source: unknown = null
  private attachedAt = 0
  private pending = new Set<string>()
  private failures: number[] = []

  /** Starts tracking a (possibly new) provider; unfinished handshakes on the old one count as failures. */
  attach(source: unknown, now: number) {
    if (source === this.source) return
    for (let i = 0; i < this.pending.size; i++) this.failures.push(now)
    this.pending.clear()
    this.source = source
    this.attachedAt = now
  }

  next(probe: SyncProbe, now: number): SyncState {
    const present = new Map(probe.peers.map(peer => [peer.id, peer]))
    for (const id of this.pending) {
      if (!present.has(id)) this.failures.push(now)
    }
    this.pending = new Set(probe.peers.filter(peer => !peer.connected).map(peer => peer.id))
    this.failures = this.failures.filter(at => now - at < FAILURE_WINDOW_MS)

    const peerCount = probe.peers.filter(peer => peer.connected && peer.synced).length
    if (peerCount > 0) {
      this.failures = []
      return { status: "live", peerCount }
    }
    if (!probe.signalingConnected) {
      const gaveUp = probe.signalingFailed || now - this.attachedAt >= SIGNALING_GRACE_MS
      return { status: gaveUp ? "unreachable" : "connecting", peerCount }
    }
    if (this.failures.length >= FAILURES_BEFORE_FAILED) return { status: "failed", peerCount }
    return { status: probe.peers.length > 0 ? "connecting" : "waiting", peerCount }
  }
}
