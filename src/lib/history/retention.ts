/**
 * Which envelopes a covering snapshot makes droppable.
 *
 * The rule from the snapshot layer, made operational: never drop the envelopes
 * a snapshot covers until its correctness has been established to *you*. A
 * snapshot's merge correctness rests on its producer's attestation, so a client
 * that has not applied one has no grounds to throw away the inputs it would
 * need to check it.
 *
 * So three conditions, all required. The snapshot must be verified, it must
 * have been applied locally, and it must still hold its payload - a degraded
 * marker proves the timeline, not the content.
 */

import { isMaterialised, type SnapshotEntry } from "@/lib/snapshots"
import type { DeliveryVector, EnvelopeLog } from "@/lib/sync"

export interface EnvelopeRef {
  author: string
  seq: number
}

export type KeptReason =
  /** No retained snapshot covers it. */
  | "not-covered"
  /** Covered only by a snapshot this client has not verified and applied. */
  | "unestablished"
  /** Covered only by a marker whose payload is gone. */
  | "not-materialised"

export interface DropPlan {
  /** Safe to let go locally. */
  drop: EnvelopeRef[]
  /** The snapshot id authorising the drop. Null when nothing is droppable. */
  behind: string | null
  kept: { ref: EnvelopeRef; reason: KeptReason }[]
}

export interface DropOptions {
  log: Pick<EnvelopeLog, "all">
  entries: readonly SnapshotEntry[]
  /** Snapshot ids this client has verified and applied. */
  established: ReadonlySet<string>
}

function covers(vector: DeliveryVector, ref: EnvelopeRef): boolean {
  return (vector[ref.author] ?? 0) >= ref.seq
}

/**
 * The deepest coverage this client is entitled to act on.
 *
 * Deepest rather than newest: a later snapshot that has not been established
 * authorises nothing, and an older established one may still cover plenty.
 */
function bestCoverage(options: DropOptions): SnapshotEntry | null {
  let best: SnapshotEntry | null = null
  for (const entry of options.entries) {
    if (!isMaterialised(entry)) continue
    if (!options.established.has(entry.id)) continue
    if (!best || entry.createdAt > best.createdAt) best = entry
  }
  return best
}

export function planDrop(options: DropOptions): DropPlan {
  const best = bestCoverage(options)
  const refs = options.log.all().map((envelope) => ({
    author: envelope.author,
    seq: envelope.seq,
  }))

  if (!best) {
    // Say which of the two reasons applies, since they need different fixes:
    // fetch the payload, or verify and apply what is already here.
    const anyMaterialised = options.entries.some(isMaterialised)
    const reason: KeptReason = anyMaterialised ? "unestablished" : "not-materialised"
    return {
      drop: [],
      behind: null,
      kept: refs.map((ref) => ({ ref, reason: options.entries.length === 0 ? "not-covered" : reason })),
    }
  }

  const drop: EnvelopeRef[] = []
  const kept: { ref: EnvelopeRef; reason: KeptReason }[] = []
  for (const ref of refs) {
    if (covers(best.covers, ref)) drop.push(ref)
    else kept.push({ ref, reason: "not-covered" })
  }
  return { drop, behind: best.id, kept }
}

/** How much of the local log a drop would reclaim, as a fraction. */
export function dropRatio(plan: DropPlan): number {
  const total = plan.drop.length + plan.kept.length
  return total === 0 ? 0 : plan.drop.length / total
}
