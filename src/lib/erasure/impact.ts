/**
 * What an erasure would actually cost, worked out before it happens.
 *
 * The foot-gun this exists for: erasing epochs without a covering snapshot
 * under a *surviving* epoch destroys the content itself, not only its history.
 * Both are legitimate operations and they are not the same one, so the
 * difference is computed rather than left to whoever is clicking.
 */

import type { Envelope } from "@/lib/sync"
import type { EpochTimeline } from "@/lib/keys"
import { isMaterialised, type SnapshotEntry } from "@/lib/snapshots"

import { erasureScope, type ErasureScope } from "./scope"

export interface ImpactInput {
  timeline: EpochTimeline
  /** Anchors this holder currently has. Erasure is per-holder. */
  heldAnchors: Iterable<number>
  targets: Iterable<number>
  /** The local log, for counting what stops being readable. */
  envelopes?: readonly Pick<Envelope, "author" | "seq" | "epoch">[]
  /** The restore-point timeline, for the same. */
  snapshots?: readonly SnapshotEntry[]
}

export interface ErasureImpact {
  scope: ErasureScope
  /** Envelopes that become permanently unreadable to this holder. */
  envelopesOrphaned: number
  /** Restore points that stop being openable. */
  snapshotsOrphaned: string[]
  /**
   * A materialised snapshot under a surviving epoch. Its existence is the
   * difference between purging history and destroying the document.
   */
  preservedBy: string | null
  /**
   * True when nothing readable would survive. Not a refusal - deleting a
   * notebook is meant to look like this - but never a side effect.
   */
  contentLost: boolean
}

export function assessErasure(input: ImpactInput): ErasureImpact {
  const scope = erasureScope(input.timeline, input.heldAnchors, input.targets)
  const gone = new Set(scope.epochs)

  const envelopesOrphaned = (input.envelopes ?? []).filter((envelope) =>
    gone.has(envelope.epoch),
  ).length

  const snapshots = input.snapshots ?? []
  const snapshotsOrphaned = snapshots
    .filter((entry) => gone.has(entry.epoch))
    .map((entry) => entry.id)

  // Newest surviving materialised snapshot. A marker will not do: it proves the
  // timeline, not the content, so it cannot preserve anything.
  const survivors = snapshots
    .filter((entry) => !gone.has(entry.epoch) && isMaterialised(entry))
    .sort((a, b) => b.createdAt - a.createdAt)

  const preservedBy = survivors[0]?.id ?? null

  // Anything still readable after the erasure - a surviving snapshot, or an
  // envelope under an epoch that survives.
  const survivingEnvelopes = (input.envelopes ?? []).some(
    (envelope) => !gone.has(envelope.epoch),
  )

  return {
    scope,
    envelopesOrphaned,
    snapshotsOrphaned,
    preservedBy,
    contentLost: preservedBy === null && !survivingEnvelopes,
  }
}

export class ErasureRefused extends Error {
  readonly impact: ErasureImpact
  constructor(message: string, impact: ErasureImpact) {
    super(message)
    this.name = "ErasureRefused"
    this.impact = impact
  }
}

/**
 * Refuse a history purge that would take the content with it.
 *
 * Only for `history` erasures. A domain erasure is supposed to leave nothing,
 * so applying this check there would refuse the operation for succeeding.
 */
export function requirePreservation(impact: ErasureImpact): void {
  if (!impact.contentLost) return
  throw new ErasureRefused(
    "refusing to purge history: nothing readable would survive. Take a snapshot under the current epoch first, or delete the notebook outright if that is what you mean.",
    impact,
  )
}

/**
 * Refuse an erasure that reaches further than asked.
 *
 * Opt-in, because collateral is often acceptable and sometimes not. Callers
 * that care use this; the rest read `scope.collateral` and say so.
 */
export function requireClean(impact: ErasureImpact): void {
  if (impact.scope.clean) return
  throw new ErasureRefused(
    `refusing to erase: epochs ${impact.scope.collateral.join(", ")} would go too, because the chain reaches them from the same anchors`,
    impact,
  )
}
