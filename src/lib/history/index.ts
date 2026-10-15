/**
 * Version history (milestone M10).
 *
 * Restore points are snapshots; the storage bound is the snapshot retention
 * policy. What is new here is attribution resolved to stable identities, a
 * restore that moves forward rather than rewinding, and the cadence that
 * decides when a restore point exists at all.
 */

export type { TimelineAttribution } from "./attribution"
export { resolveAll, resolveAttribution } from "./attribution"

export type { BuildTimelineOptions, RestoreBlocker, RestorePoint, SessionEntry } from "./timeline"
export { buildTimeline, historyHorizon, restorePointsByDay, timelineFor } from "./timeline"

export type {
  ApplyRestoreOptions,
  RestoreBody,
  RestorePlan,
  RestoreTarget,
  RestoreRecord,
  RestoreResult,
  RestoredRegion,
} from "./restore"
export {
  applyRestore,
  applyRestoreToState,
  originalAuthors,
  planRestore,
  planRestoreToState,
  RESTORE_VERSION,
  restoreBytes,
  verifyRestoreRecord,
} from "./restore"

export type { CadencePolicy, CadenceState, SnapshotReason } from "./cadence"
export { DEFAULT_CADENCE, SnapshotCadence } from "./cadence"

export type { DropOptions, DropPlan, EnvelopeRef, KeptReason } from "./retention"
export { dropRatio, planDrop } from "./retention"
