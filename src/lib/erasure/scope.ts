/**
 * What has to be destroyed to make a given epoch unreadable.
 *
 * Not just that epoch's key. Within a segment the chain runs forward, so anyone
 * holding an earlier anchor can re-derive it - erasing epoch 7 means destroying
 * every anchor from the segment start through 7, which takes 5 and 6 with it.
 *
 * That collateral is the central fact about erasure here, and it is returned
 * rather than absorbed: a caller that thinks it is deleting one epoch and is
 * actually deleting four needs to know before it acts.
 */

import { segmentStart, type EpochTimeline } from "@/lib/keys"

export interface ErasureScope {
  /** Anchors this holder must destroy. */
  anchors: number[]
  /** Epochs that become unreadable as a result. */
  epochs: number[]
  /** Epochs lost that were not asked for - the cost of the chain. */
  collateral: number[]
  /**
   * True when the request lines up with a segment boundary, so nothing extra
   * is lost. Erasing from a rotation costs nothing; erasing mid-chain does.
   */
  clean: boolean
}

/**
 * Which anchors a holder must destroy so `targets` become unreachable.
 *
 * Takes the holder's anchors rather than working from the timeline alone,
 * because two members of the same notebook hold different anchors and so lose
 * different amounts. Erasure is per-holder; there is no global answer.
 */
export function erasureScope(
  timeline: EpochTimeline,
  heldAnchors: Iterable<number>,
  targets: Iterable<number>,
): ErasureScope {
  const held = [...heldAnchors].sort((a, b) => a - b)
  const wanted = new Set(targets)

  const doomed = new Set<number>()
  for (const target of wanted) {
    const start = segmentStart(timeline, target)
    for (const anchor of held) {
      // An anchor reaches the target when it sits inside the same segment at or
      // before it. Those are exactly the anchors that must go.
      if (anchor >= start && anchor <= target) doomed.add(anchor)
    }
  }

  // Everything those anchors could still have reached is lost with them.
  const epochs: number[] = []
  for (let epoch = 1; epoch <= timeline.length; epoch += 1) {
    const reachableBefore = held.some(
      (anchor) => anchor <= epoch && segmentStart(timeline, epoch) <= anchor,
    )
    if (!reachableBefore) continue
    const reachableAfter = held.some(
      (anchor) =>
        !doomed.has(anchor) && anchor <= epoch && segmentStart(timeline, epoch) <= anchor,
    )
    if (!reachableAfter) epochs.push(epoch)
  }

  const collateral = epochs.filter((epoch) => !wanted.has(epoch))
  return {
    anchors: [...doomed].sort((a, b) => a - b),
    epochs,
    collateral,
    clean: collateral.length === 0,
  }
}

/**
 * Every epoch up to and including `throughEpoch` - the history-purge shape.
 *
 * Erasing a prefix is the operation that is always clean, because a prefix
 * never leaves an anchor behind that reaches into it.
 */
export function prefixTargets(throughEpoch: number): number[] {
  return Array.from({ length: Math.max(0, throughEpoch) }, (_, index) => index + 1)
}

/**
 * The next epoch at or after `from` where erasing costs no collateral.
 *
 * Useful for saying "erase from here instead" rather than only refusing. A
 * segment start is such a point: nothing before it can derive across it.
 */
export function nextCleanBoundary(timeline: EpochTimeline, from: number): number | null {
  for (let epoch = Math.max(1, from); epoch <= timeline.length; epoch += 1) {
    if (segmentStart(timeline, epoch) === epoch) return epoch
  }
  return null
}
