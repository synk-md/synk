import { describe, expect, it } from "vitest"
import { SyncStatusTracker, type PeerProbe, type SyncProbe } from "./sync-status"

const probe = (peers: PeerProbe[] = [], signaling: Partial<SyncProbe> = {}): SyncProbe => ({
  signalingConnected: true,
  signalingFailed: false,
  peers,
  ...signaling,
})
const handshaking = (id: string): PeerProbe => ({ id, connected: false, synced: false })
const synced = (id: string): PeerProbe => ({ id, connected: true, synced: true })

function attached(now = 0) {
  const tracker = new SyncStatusTracker()
  tracker.attach("provider", now)
  return tracker
}

describe("SyncStatusTracker", () => {
  it("waits rather than claiming to be synced when no one else is around", () => {
    expect(attached().next(probe(), 0)).toEqual({ status: "waiting", peerCount: 0 })
  })

  it("is live only with a connected, synced peer", () => {
    const tracker = attached()
    expect(tracker.next(probe([handshaking("a")]), 0).status).toBe("connecting")
    expect(tracker.next(probe([{ id: "a", connected: true, synced: false }]), 1).status).toBe("connecting")
    expect(tracker.next(probe([synced("a"), synced("b")]), 2)).toEqual({ status: "live", peerCount: 2 })
  })

  it("gives the signaling server a grace period before calling it unreachable", () => {
    const tracker = attached(0)
    const down = probe([], { signalingConnected: false })
    expect(tracker.next(down, 1_000).status).toBe("connecting")
    expect(tracker.next(down, 5_000).status).toBe("unreachable")
  })

  it("is unreachable straight away once a signaling attempt has failed", () => {
    expect(attached().next(probe([], { signalingConnected: false, signalingFailed: true }), 0).status).toBe("unreachable")
  })

  it("stays live over peers it already has when signaling drops", () => {
    expect(attached().next(probe([synced("a")], { signalingConnected: false }), 60_000).status).toBe("live")
  })

  it("fails after repeated handshakes vanish without connecting", () => {
    const tracker = attached()
    tracker.next(probe([handshaking("a")]), 0)
    expect(tracker.next(probe(), 1_000).status).toBe("waiting")
    tracker.next(probe([handshaking("a")]), 2_000)
    expect(tracker.next(probe([handshaking("a")]), 3_000).status).toBe("connecting")
    expect(tracker.next(probe(), 4_000).status).toBe("failed")
  })

  it("counts a provider swap mid-handshake as a failure", () => {
    const tracker = attached()
    tracker.next(probe([handshaking("a")]), 0)
    tracker.attach("retry-1", 8_000)
    tracker.next(probe([handshaking("a")]), 8_000)
    tracker.attach("retry-2", 16_000)
    expect(tracker.next(probe([handshaking("a")]), 16_000).status).toBe("failed")
  })

  it("does not count re-attaching the same provider", () => {
    const tracker = attached()
    tracker.next(probe([handshaking("a")]), 0)
    tracker.attach("provider", 1_000)
    tracker.attach("provider", 2_000)
    expect(tracker.next(probe([handshaking("a")]), 3_000).status).toBe("connecting")
  })

  it("forgets old failures", () => {
    const tracker = attached()
    tracker.next(probe([handshaking("a")]), 0)
    tracker.next(probe(), 1_000)
    tracker.next(probe([handshaking("a")]), 2_000)
    expect(tracker.next(probe(), 3_000).status).toBe("failed")
    expect(tracker.next(probe(), 40_000).status).toBe("waiting")
  })

  it("clears failures once a peer syncs", () => {
    const tracker = attached()
    tracker.next(probe([handshaking("a")]), 0)
    tracker.next(probe(), 1_000)
    tracker.next(probe([handshaking("a")]), 2_000)
    tracker.next(probe(), 3_000)
    tracker.next(probe([synced("a")]), 4_000)
    expect(tracker.next(probe(), 5_000).status).toBe("waiting")
  })
})
