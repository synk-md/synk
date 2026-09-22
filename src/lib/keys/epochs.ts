/**
 * The epoch timeline and the key chain underneath it.
 *
 * A new epoch is cut at every membership change. Which epoch keys a member
 * holds is exactly which parts of the history they can decrypt, so the two
 * required properties are properties of how keys relate to each other:
 *
 *   history excluded on join   a joiner must not derive backwards
 *   removal denies future reads  a removed member must not derive forwards
 *
 * A single hash chain gives one or the other, never both. So the chain runs
 * forward *within a segment* and is broken at every removal:
 *
 *   join     `chain`     k(n+1) = KDF(k(n)). Existing members derive the new
 *                        key themselves, so the reseal is to the joiner only.
 *                        One-way, so the joiner cannot reach earlier epochs.
 *   removal  `rotation`  fresh random seed, flat-resealed to everyone who
 *                        remains. The removed member holds a key the chain no
 *                        longer reaches from.
 *
 * That asymmetry is deliberate: joins are frequent and cost O(1) seals,
 * removals are rare and cost O(members). It is also what keeps the retained
 * keyring near-constant - a member keeps one anchor per segment they were in,
 * not one key per epoch.
 */

import { deriveKey, generateAeadKey, type Bytes } from "@/lib/crypto"

export const EPOCH_RECORD_VERSION = 1

/** How an epoch's key relates to the one before it. */
export type EpochKind = "genesis" | "chain" | "rotation"

export type EpochReason = "genesis" | "member-added" | "member-removed" | "manual-rotation"

export interface EpochRecord {
  v: typeof EPOCH_RECORD_VERSION
  /** The key domain - a notebook, or a note promoted to its own key. */
  domain: string
  /** 1-based, contiguous. */
  epoch: number
  kind: EpochKind
  reason: EpochReason
  createdAt: number
}

/** Ordered, contiguous from 1. */
export type EpochTimeline = readonly EpochRecord[]

export function genesisEpoch(domain: string, createdAt = Date.now()): EpochRecord {
  return { v: EPOCH_RECORD_VERSION, domain, epoch: 1, kind: "genesis", reason: "genesis", createdAt }
}

/** Advance the chain one step. One-way, so earlier keys stay unreachable. */
export function deriveChainedEpochKey(previous: Bytes): Promise<Bytes> {
  return deriveKey(previous, "synk/epoch-chain/v1")
}

/** A fresh seed, unreachable from any earlier key. Used at every removal. */
export function generateEpochSeed(): Bytes {
  return generateAeadKey()
}

export function timelineIsWellFormed(timeline: EpochTimeline): boolean {
  if (timeline.length === 0) return false
  const domain = timeline[0].domain
  return timeline.every(
    (record, index) =>
      record.v === EPOCH_RECORD_VERSION &&
      record.domain === domain &&
      record.epoch === index + 1 &&
      (index === 0 ? record.kind === "genesis" : record.kind !== "genesis"),
  )
}

/**
 * First epoch of the segment containing `epoch` - the most recent epoch whose
 * key was *not* derived from its predecessor.
 *
 * Derivation may run forward from any anchor at or after this point, and never
 * across it.
 */
export function segmentStart(timeline: EpochTimeline, epoch: number): number {
  for (let candidate = epoch; candidate >= 1; candidate -= 1) {
    const record = timeline[candidate - 1]
    if (!record) break
    if (record.kind !== "chain") return candidate
  }
  return 1
}

/** Can a member holding the key for `anchor` reach `target` by derivation? */
export function isReachable(timeline: EpochTimeline, anchor: number, target: number): boolean {
  if (target < anchor) return false // the chain is one-way
  if (target > timeline.length) return false
  return segmentStart(timeline, target) <= anchor
}

/**
 * Derive the key for `target` from the best anchor available, or undefined
 * when no held key reaches it.
 *
 * The anchors a member holds are the epoch keys sealed to them. Everything else
 * they can reach is computed, which is why the keyring does not grow with the
 * epoch count.
 */
export async function resolveEpochKey(
  timeline: EpochTimeline,
  anchors: ReadonlyMap<number, Bytes>,
  target: number,
): Promise<Bytes | undefined> {
  const held = anchors.get(target)
  if (held) return held

  // The closest anchor below the target derives in the fewest steps.
  let best: number | undefined
  for (const anchor of anchors.keys()) {
    if (isReachable(timeline, anchor, target) && (best === undefined || anchor > best)) {
      best = anchor
    }
  }
  if (best === undefined) return undefined

  let key = anchors.get(best)!
  for (let step = best; step < target; step += 1) {
    key = await deriveChainedEpochKey(key)
  }
  return key
}

/** Every epoch a member holding these anchors can open, ascending. */
export function reachableEpochs(
  timeline: EpochTimeline,
  anchors: ReadonlyMap<number, Bytes>,
): number[] {
  const reachable: number[] = []
  for (let epoch = 1; epoch <= timeline.length; epoch += 1) {
    if ([...anchors.keys()].some((anchor) => isReachable(timeline, anchor, epoch))) {
      reachable.push(epoch)
    }
  }
  return reachable
}
