/**
 * When to take a snapshot.
 *
 * Three triggers, and the epoch one is not negotiable. A membership change cuts
 * a new epoch, and until a snapshot exists under it the next joiner has no
 * baseline and the envelopes under the old epoch can never be dropped - so an
 * epoch boundary is always due, whatever the activity and time thresholds say.
 *
 * Activity and time are both needed because either alone misses a case: a long
 * slow edit never trips an update count, and a burst never trips a clock.
 */

export type SnapshotReason = "epoch" | "activity" | "time" | "manual"

export interface CadencePolicy {
  /** Updates since the last snapshot before one is due. */
  everyUpdates: number
  /** Elapsed ms since the last snapshot before one is due. */
  everyMs: number
  /** Never snapshot more often than this, however busy things get. */
  minIntervalMs?: number
}

export const DEFAULT_CADENCE: CadencePolicy = {
  everyUpdates: 200,
  everyMs: 15 * 60 * 1000,
  minIntervalMs: 30 * 1000,
}

export interface CadenceState {
  updatesSince: number
  lastAt: number | null
  lastEpoch: number | null
  pendingEpoch: number | null
}

export class SnapshotCadence {
  private readonly policy: CadencePolicy
  private state: CadenceState = {
    updatesSince: 0,
    lastAt: null,
    lastEpoch: null,
    pendingEpoch: null,
  }

  constructor(policy: CadencePolicy = DEFAULT_CADENCE) {
    this.policy = policy
  }

  get snapshot(): CadenceState {
    return { ...this.state }
  }

  noteUpdate(): void {
    this.state.updatesSince += 1
  }

  /** A new epoch was cut. Due immediately, and exempt from the floor. */
  noteEpoch(epoch: number): void {
    if (this.state.lastEpoch === epoch) return
    this.state.pendingEpoch = epoch
  }

  markTaken(at: number, epoch: number): void {
    this.state = { updatesSince: 0, lastAt: at, lastEpoch: epoch, pendingEpoch: null }
  }

  /**
   * Why a snapshot is due, or null.
   *
   * The epoch check comes before the rate floor deliberately: a boundary
   * snapshot that was skipped for being too soon would leave the next joiner
   * without a baseline until the following one, which may be a long way off.
   */
  due(now: number): SnapshotReason | null {
    if (this.state.pendingEpoch !== null) return "epoch"

    const floor = this.policy.minIntervalMs ?? 0
    if (this.state.lastAt !== null && now - this.state.lastAt < floor) return null

    if (this.state.lastAt === null) {
      return this.state.updatesSince > 0 ? "activity" : null
    }
    if (this.state.updatesSince >= this.policy.everyUpdates) return "activity"
    if (now - this.state.lastAt >= this.policy.everyMs && this.state.updatesSince > 0) return "time"
    return null
  }

  /** Nothing has changed, so a snapshot would only duplicate the last one. */
  get idle(): boolean {
    return this.state.updatesSince === 0 && this.state.pendingEpoch === null
  }
}
