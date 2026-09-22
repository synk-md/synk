import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateAeadKey, generateSigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import { createSnapshot, type Snapshot, type SnapshotKind } from "./snapshot"
import {
  applyRetention,
  DEFAULT_RETENTION,
  isMaterialised,
  isPinned,
  SnapshotStore,
  toMarker,
  type SnapshotEntry,
} from "./store"

const DOMAIN = "notebook:1"

async function snapshotAt(
  createdAt: number,
  options: { kind?: SnapshotKind; label?: string } = {},
): Promise<Snapshot> {
  const signingKey = await generateSigningKey()
  const doc = new Y.Doc()
  doc.getText("t").insert(0, `state-${String(createdAt)}`)
  return createSnapshot({
    signingKey,
    author: didFromSigningKey(signingKey.publicKey),
    domain: DOMAIN,
    resourceId: DOMAIN,
    kind: options.kind ?? "automatic",
    epoch: 1,
    dek: generateAeadKey(),
    state: Y.encodeStateAsUpdate(doc),
    covers: {},
    createdAt,
    ...(options.label === undefined ? {} : { label: options.label }),
  })
}

describe("toMarker", () => {
  // A marker keeps the timeline complete and the chain walkable; only the
  // payload goes.
  it("keeps everything except the payload", async () => {
    const snapshot = await snapshotAt(1, { kind: "checkpoint", label: "before the rewrite" })
    const marker = toMarker(snapshot)

    expect(marker.id).toBe(snapshot.id)
    expect(marker.stateHash).toBe(snapshot.stateHash)
    expect(marker.parent).toBe(snapshot.parent)
    expect(marker.label).toBe("before the rewrite")
    expect(marker.materialised).toBe(false)
    expect(marker).not.toHaveProperty("ct")
    expect(marker).not.toHaveProperty("sig")
  })
})

describe("applyRetention", () => {
  it("keeps the most recent window materialised", async () => {
    const entries: SnapshotEntry[] = []
    for (let i = 1; i <= 5; i += 1) {
      entries.push({ materialised: true, ...(await snapshotAt(i)) })
    }

    const { entries: next, degraded } = applyRetention(entries, { window: 2 })
    expect(next.filter(isMaterialised).map((e) => e.createdAt)).toEqual([4, 5])
    expect(degraded).toHaveLength(3)
  })

  it("keeps pinned checkpoints however old", async () => {
    const entries: SnapshotEntry[] = [
      { materialised: true, ...(await snapshotAt(1, { kind: "checkpoint", label: "pinned" })) },
      { materialised: true, ...(await snapshotAt(2)) },
      { materialised: true, ...(await snapshotAt(3)) },
      { materialised: true, ...(await snapshotAt(4)) },
    ]

    const { entries: next } = applyRetention(entries, { window: 1 })
    expect(next.filter(isMaterialised).map((e) => e.createdAt)).toEqual([1, 4])
  })

  it("can drop pinned checkpoints when asked", async () => {
    const entries: SnapshotEntry[] = [
      { materialised: true, ...(await snapshotAt(1, { kind: "checkpoint", label: "pinned" })) },
      { materialised: true, ...(await snapshotAt(2)) },
    ]
    const { entries: next } = applyRetention(entries, { window: 1, keepPinned: false })
    expect(next.filter(isMaterialised).map((e) => e.createdAt)).toEqual([2])
  })

  it("is idempotent and leaves markers alone", async () => {
    const entries: SnapshotEntry[] = []
    for (let i = 1; i <= 4; i += 1) entries.push({ materialised: true, ...(await snapshotAt(i)) })

    const once = applyRetention(entries, { window: 1 })
    const twice = applyRetention(once.entries, { window: 1 })
    expect(twice.degraded).toEqual([])
    expect(twice.entries.filter(isMaterialised)).toHaveLength(1)
  })

  it("accepts a window of zero, keeping only pinned checkpoints", async () => {
    const entries: SnapshotEntry[] = [
      { materialised: true, ...(await snapshotAt(1, { kind: "checkpoint", label: "keep me" })) },
      { materialised: true, ...(await snapshotAt(2)) },
    ]
    const { entries: next } = applyRetention(entries, { window: 0 })
    expect(next.filter(isMaterialised).map((e) => e.label)).toEqual(["keep me"])
  })

  it("orders by creation time regardless of input order", async () => {
    const a = await snapshotAt(3)
    const b = await snapshotAt(1)
    const c = await snapshotAt(2)
    const { entries } = applyRetention(
      [a, b, c].map((s) => ({ materialised: true as const, ...s })),
      { window: 1 },
    )
    expect(entries.map((e) => e.createdAt)).toEqual([1, 2, 3])
    expect(entries.filter(isMaterialised).map((e) => e.createdAt)).toEqual([3])
  })
})

describe("isPinned", () => {
  it("is a labelled checkpoint and nothing else", async () => {
    expect(isPinned({ materialised: true, ...(await snapshotAt(1, { kind: "checkpoint", label: "x" })) })).toBe(true)
    expect(isPinned({ materialised: true, ...(await snapshotAt(1, { kind: "checkpoint" })) })).toBe(false)
    expect(isPinned({ materialised: true, ...(await snapshotAt(1, { kind: "join" })) })).toBe(false)
  })
})

describe("SnapshotStore", () => {
  // The storage bound, stated as a test: the payload count stays flat no matter
  // how much history accumulates.
  it("keeps materialised payloads flat as history grows", async () => {
    const store = new SnapshotStore({ window: 3 })
    for (let i = 1; i <= 25; i += 1) store.add(await snapshotAt(i))

    expect(store.size).toBe(25)
    expect(store.materialisedCount).toBe(3)
    expect(store.entries()).toHaveLength(25)
  })

  it("hands degraded payloads to the archive exactly once", async () => {
    const store = new SnapshotStore({ window: 1 })
    for (let i = 1; i <= 4; i += 1) store.add(await snapshotAt(i))

    const archived = store.drainArchive()
    expect(archived.map((s) => s.createdAt)).toEqual([1, 2, 3])
    expect(store.drainArchive()).toEqual([])
  })

  it("keeps the full restore-point timeline visible after degrading", async () => {
    const store = new SnapshotStore({ window: 1 })
    for (let i = 1; i <= 4; i += 1) store.add(await snapshotAt(i))

    const timeline = store.entries()
    expect(timeline.map((e) => e.createdAt)).toEqual([1, 2, 3, 4])
    expect(timeline.filter((e) => !isMaterialised(e))).toHaveLength(3)
    // Every entry still carries what a timeline needs to show.
    expect(timeline.every((e) => typeof e.author === "string" && e.stateHash.length > 0)).toBe(true)
  })

  it("ignores a snapshot it already holds", async () => {
    const store = new SnapshotStore()
    const snapshot = await snapshotAt(1)
    store.add(snapshot)
    store.add(snapshot)
    expect(store.size).toBe(1)
  })

  it("offers the newest materialised payload for a fresh joiner", async () => {
    const store = new SnapshotStore({ window: 2 })
    for (let i = 1; i <= 5; i += 1) store.add(await snapshotAt(i))
    expect(store.latestMaterialised()?.createdAt).toBe(5)
    expect(store.tip()?.createdAt).toBe(5)
  })

  it("defaults to a window of three", async () => {
    const store = new SnapshotStore()
    for (let i = 1; i <= 10; i += 1) store.add(await snapshotAt(i))
    expect(store.materialisedCount).toBe(DEFAULT_RETENTION.window)
  })

  it("retains a pinned checkpoint's payload beyond the window", async () => {
    const store = new SnapshotStore({ window: 1 })
    store.add(await snapshotAt(1, { kind: "checkpoint", label: "release" }))
    for (let i = 2; i <= 6; i += 1) store.add(await snapshotAt(i))

    expect(store.materialised().map((s) => s.label)).toEqual(["release", undefined])
  })
})
