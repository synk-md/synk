/**
 * Snapshots (milestone M6).
 *
 * A membership prerequisite, not only a version-history feature: without a
 * snapshot, a member added to a non-empty notebook is deaf to every
 * pre-existing author, because a gap in an author's clock sequence blocks all
 * of that author's later operations.
 */

export type {
  EpochKeySource,
  CreateSnapshotOptions,
  Snapshot,
  SnapshotHeader,
  SnapshotKind,
} from "./snapshot"
export {
  chainFrom,
  createSnapshot,
  openSnapshot,
  openSnapshotWith,
  rewrapSnapshot,
  snapshotHeader,
  snapshotHeaderBytes,
  snapshotIdOf,
  snapshotSignedBytes,
  SNAPSHOT_VERSION,
  verifySnapshot,
} from "./snapshot"

export type { JoinSnapshotOptions } from "./join"
export { authorsPresent, createJoinSnapshot, needsJoinSnapshot, rebaselinedAuthors } from "./join"

export type {
  AdmitMemberOptions,
  CollectJoinMaterialOptions,
  JoinGrant,
  StalenessReport,
} from "./join-grant"
export {
  admissionStaleness,
  admitMemberWithSnapshot,
  collectJoinSnapshot,
  depositJoinGrant,
} from "./join-grant"

export type { PromotionSnapshotOptions } from "./promotion"
export { createPromotionSnapshot, supersededNotebookEpoch } from "./promotion"

export type { RestorePointMarker, RetentionPolicy, RetentionResult, SnapshotEntry } from "./store"
export {
  applyRetention,
  DEFAULT_RETENTION,
  isMaterialised,
  isPinned,
  SnapshotStore,
  toMarker,
} from "./store"

export type { SnapshotKeyWrap, SnapshotKeyWrapBody, WrapOptions } from "./key-wrap"
export {
  coversCurrentState,
  generateSnapshotKey,
  reachableWraps,
  rewrapForEpoch,
  SNAPSHOT_WRAP_VERSION,
  unwrapSnapshotKey,
  verifySnapshotWrap,
  wrapAad,
  wrapBytes,
  wrapSnapshotKey,
} from "./key-wrap"
