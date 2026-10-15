/**
 * The restore-point timeline: snapshot entries plus who made them and whether
 * this member can actually go back to them.
 *
 * Restorable is not the same as visible. A snapshot sealed under an epoch this
 * member never held is listed - the history exists and pretending otherwise
 * would be a lie - but it cannot be opened, so restoring to it is refused here
 * rather than failing later with a decryption error.
 */

import type { ReadKeySource } from "@/lib/keys"
import type { User } from "@/lib/identity"
import { isMaterialised, type SnapshotEntry } from "@/lib/snapshots"

import { resolveAll, type TimelineAttribution } from "./attribution"

export type RestoreBlocker =
  /** Sealed under an epoch this member cannot derive. */
  | "outside-visible-history"
  /** The payload was let go locally; fetch it from the archive first. */
  | "payload-archived"
  /** This is where the document already is. */
  | "current"

export interface RestorePoint {
  id: string
  resourceId: string
  domain: string
  /** A session is someone's run of edits, rebuilt from the envelopes rather than stored. */
  kind: SnapshotEntry["kind"] | "session"
  epoch: number
  createdAt: number
  /** User-given name, for a pinned checkpoint. */
  label: string | null
  parent: string | null
  attribution: TimelineAttribution
  /** False when the payload is not held locally. */
  materialised: boolean
  restorable: boolean
  blocker: RestoreBlocker | null
  /** How many changes a session holds. */
  changes?: number
}

/** A run of one person's edits, as the timeline needs it. */
export interface SessionEntry {
  id: string
  resourceId: string
  domain: string
  author: string
  /** When it ended, which is the point it restores to. */
  createdAt: number
  /** Every epoch its changes were sealed under. */
  epochs: readonly number[]
  changes: number
}

export interface BuildTimelineOptions {
  entries: readonly SnapshotEntry[]
  sessions?: readonly SessionEntry[]
  users: readonly User[]
  /** Epochs this member can open. Anything else is outside their history. */
  readableEpochs: readonly number[]
  /** Id of the point the document currently sits at, when known. */
  currentId?: string | null
}

/**
 * Newest first, which is the order a person reads a history in. The chain's own
 * order is oldest-first and stays that way in the store.
 */
export function buildTimeline(options: BuildTimelineOptions): RestorePoint[] {
  const readable = new Set(options.readableEpochs)
  const sessions = options.sessions ?? []
  const attributions = resolveAll(
    [...options.entries, ...sessions].map((entry) => entry.author),
    options.users,
  )
  const attributionOf = (author: string): TimelineAttribution =>
    attributions.get(author) ??
    ({
      author,
      member: null,
      label: author,
      assurance: "self-asserted",
      conflict: null,
      unknown: true,
    } satisfies TimelineAttribution)

  const sessionPoints = sessions.map((session): RestorePoint => {
    const blocker: RestoreBlocker | null = !session.epochs.every((epoch) => readable.has(epoch))
      ? "outside-visible-history"
      : session.id === options.currentId
        ? "current"
        : null
    return {
      id: session.id,
      resourceId: session.resourceId,
      domain: session.domain,
      kind: "session",
      epoch: Math.max(...session.epochs),
      createdAt: session.createdAt,
      label: null,
      parent: null,
      attribution: attributionOf(session.author),
      materialised: true,
      restorable: blocker === null,
      blocker,
      changes: session.changes,
    }
  })

  const snapshotPoints = [...options.entries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((entry): RestorePoint => {
      const materialised = isMaterialised(entry)
      // A snapshot re-sealed for this member opens under their epoch while
      // still recording the one it was built in, so reachability comes from
      // its wraps. A marker has none, because it has no payload to open.
      const reachable = materialised
        ? entry.wraps.some((wrap) => readable.has(wrap.epoch))
        : readable.has(entry.epoch)
      const blocker: RestoreBlocker | null = !reachable
        ? "outside-visible-history"
        : entry.id === options.currentId
          ? "current"
          : !materialised
            ? "payload-archived"
            : null

      return {
        id: entry.id,
        resourceId: entry.resourceId,
        domain: entry.domain,
        kind: entry.kind,
        epoch: entry.epoch,
        createdAt: entry.createdAt,
        label: entry.label ?? null,
        parent: entry.parent,
        attribution: attributionOf(entry.author),
        materialised,
        restorable: blocker === null,
        blocker,
      }
    })

  return [...snapshotPoints, ...sessionPoints].sort((a, b) => b.createdAt - a.createdAt)
}

/** Where a member's own visible history begins. Null when they can see it all. */
export function historyHorizon(points: readonly RestorePoint[]): RestorePoint | null {
  const hidden = points.filter((point) => point.blocker === "outside-visible-history")
  if (hidden.length === 0) return null
  return hidden.reduce((oldest, point) => (point.createdAt < oldest.createdAt ? point : oldest))
}

export function restorePointsByDay(points: readonly RestorePoint[]): Map<string, RestorePoint[]> {
  const byDay = new Map<string, RestorePoint[]>()
  for (const point of points) {
    const day = new Date(point.createdAt).toISOString().slice(0, 10)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(point)
    else byDay.set(day, [point])
  }
  return byDay
}

/** Convenience for the common case: the store's entries plus a live keyring. */
export function timelineFor(
  entries: readonly SnapshotEntry[],
  users: readonly User[],
  keys: Pick<ReadKeySource, "readableEpochs">,
  currentId?: string | null,
): RestorePoint[] {
  return buildTimeline({
    entries,
    users,
    readableEpochs: keys.readableEpochs(),
    ...(currentId === undefined ? {} : { currentId }),
  })
}
