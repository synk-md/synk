/**
 * Retention: the storage bound, stated rather than left implicit.
 *
 * Snapshots are full materialised state, so keeping every one would grow client
 * storage with total history - the thing local-first is supposed to avoid. The
 * policy:
 *
 *   retain   full payloads for a bounded recent window, plus every explicitly
 *            pinned checkpoint
 *   degrade  superseded snapshots to lightweight restore-point markers - id,
 *            author, coverage, hash, label, but no payload
 *   archive  the deep tail (older payloads, undropped envelopes) server-side
 *
 * Result: client storage flat in total history, server storage tierable.
 *
 * A marker is deliberately not nothing. It keeps the restore-point timeline
 * complete and the hash chain walkable, so history stays *visible* even where
 * it is no longer *materialised* locally - the payload is refetched from the
 * archive on demand.
 *
 * Incremental or delta snapshots (Sedimentree-shaped) stay deferred. They are
 * the answer to full-snapshot retention being the cost that hurts, and that has
 * not been measured yet; adding them now would be complexity bought on a guess.
 */

import type { DeliveryVector } from "@/lib/sync"
import type { Snapshot, SnapshotKind } from "./snapshot"

/** What survives locally once a snapshot's payload is let go. */
export interface RestorePointMarker {
  id: string
  domain: string
  resourceId: string
  kind: SnapshotKind
  author: string
  epoch: number
  covers: DeliveryVector
  parent: string | null
  stateHash: string
  label?: string
  createdAt: number
  /** Always true - the distinguishing field when reading a mixed timeline. */
  materialised: false
}

export type SnapshotEntry = ({ materialised: true } & Snapshot) | RestorePointMarker

export interface RetentionPolicy {
  /**
   * How many of the most recent snapshots keep their payload. Zero is legal and
   * means "pinned checkpoints only".
   */
  window: number
  /** Keep payloads for labelled checkpoints regardless of age. Defaults to true. */
  keepPinned?: boolean
}

export const DEFAULT_RETENTION: RetentionPolicy = { window: 3, keepPinned: true }

export function toMarker(snapshot: Snapshot): RestorePointMarker {
  const marker: RestorePointMarker = {
    id: snapshot.id,
    domain: snapshot.domain,
    resourceId: snapshot.resourceId,
    kind: snapshot.kind,
    author: snapshot.author,
    epoch: snapshot.epoch,
    covers: { ...snapshot.covers },
    parent: snapshot.parent,
    stateHash: snapshot.stateHash,
    createdAt: snapshot.createdAt,
    materialised: false,
  }
  if (snapshot.label !== undefined) marker.label = snapshot.label
  return marker
}

export function isMaterialised(entry: SnapshotEntry): entry is { materialised: true } & Snapshot {
  return entry.materialised
}

/** Drop the store's own bookkeeping flag, leaving the snapshot as published. */
function stripMarker(entry: { materialised: true } & Snapshot): Snapshot {
  return {
    v: entry.v,
    domain: entry.domain,
    resourceId: entry.resourceId,
    kind: entry.kind,
    author: entry.author,
    epoch: entry.epoch,
    covers: entry.covers,
    parent: entry.parent,
    stateHash: entry.stateHash,
    createdAt: entry.createdAt,
    nonce: entry.nonce,
    ct: entry.ct,
    sig: entry.sig,
    id: entry.id,
    ...(entry.supersedesNotebookEpoch === undefined
      ? {}
      : { supersedesNotebookEpoch: entry.supersedesNotebookEpoch }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  }
}

/** A pinned checkpoint - user-named, kept regardless of age. */
export function isPinned(entry: SnapshotEntry): boolean {
  return entry.kind === "checkpoint" && typeof entry.label === "string" && entry.label.length > 0
}

export interface RetentionResult {
  entries: SnapshotEntry[]
  /** Ids whose payload was dropped locally and now lives archive-side only. */
  degraded: string[]
}

/**
 * Apply the policy to a timeline, newest last.
 *
 * Pure: returns the new timeline and what was degraded, so the caller decides
 * what to hand the archive before letting go of it.
 */
export function applyRetention(
  entries: readonly SnapshotEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionResult {
  const keepPinned = policy.keepPinned ?? true
  const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt)
  const window = Math.max(0, policy.window)
  const recent = new Set(ordered.slice(Math.max(0, ordered.length - window)).map((e) => e.id))

  const degraded: string[] = []
  const next = ordered.map((entry): SnapshotEntry => {
    if (!isMaterialised(entry)) return entry
    if (recent.has(entry.id)) return entry
    if (keepPinned && isPinned(entry)) return entry
    degraded.push(entry.id)
    return toMarker(entry)
  })
  return { entries: next, degraded }
}

/**
 * A bounded local store that degrades as it grows.
 *
 * Deliberately not a persistence layer - it holds the policy and the timeline,
 * and says what the archive should be given. Where those bytes actually go is
 * M8's.
 */
export class SnapshotStore {
  private readonly policy: RetentionPolicy
  private timeline: SnapshotEntry[] = []
  /** Ids handed to the archive since the last drain. */
  private pendingArchive: Snapshot[] = []

  constructor(policy: RetentionPolicy = DEFAULT_RETENTION) {
    this.policy = policy
  }

  add(snapshot: Snapshot): void {
    if (this.timeline.some((entry) => entry.id === snapshot.id)) return
    this.timeline.push({ materialised: true, ...snapshot })
    this.prune()
  }

  private prune(): void {
    const byId = new Map(
      this.timeline.filter(isMaterialised).map((entry) => [entry.id, entry] as const),
    )
    const { entries, degraded } = applyRetention(this.timeline, this.policy)
    this.timeline = entries
    for (const id of degraded) {
      const full = byId.get(id)
      if (full) this.pendingArchive.push(stripMarker(full))
    }
  }

  /** The restore-point timeline, complete whether or not payloads remain. */
  entries(): SnapshotEntry[] {
    return [...this.timeline]
  }

  /** Payloads still held locally. */
  materialised(): Snapshot[] {
    return this.timeline.filter(isMaterialised).map(stripMarker)
  }

  get(id: string): SnapshotEntry | undefined {
    return this.timeline.find((entry) => entry.id === id)
  }

  /** The newest snapshot still holding its payload, for a fresh joiner. */
  latestMaterialised(): Snapshot | undefined {
    return this.materialised().at(-1)
  }

  /** The tip of the chain, materialised or not - what a new snapshot parents to. */
  tip(): SnapshotEntry | undefined {
    return this.timeline.at(-1)
  }

  /** Hand the archive what has been let go locally, and forget it. */
  drainArchive(): Snapshot[] {
    const drained = this.pendingArchive
    this.pendingArchive = []
    return drained
  }

  get size(): number {
    return this.timeline.length
  }

  /** How many payloads are held locally - the number that stays bounded. */
  get materialisedCount(): number {
    return this.timeline.filter(isMaterialised).length
  }
}
