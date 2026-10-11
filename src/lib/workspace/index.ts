/**
 * A notebook as a workspace: an owner established by a signed genesis record,
 * and a directory of member devices carried in the notebook's own index doc.
 */

export type {
  Ownership,
  OwnershipStatus,
  VerifyGenesisOptions,
  WorkspaceGenesis,
  WorkspaceGenesisBody,
} from "./genesis"
export {
  createGenesis,
  genesisBytes,
  GENESIS_VERSION,
  resolveOwnership,
  verifyGenesis,
} from "./genesis"

export type {
  FoundedWorkspace,
  FoundOptions,
  NotebookWorkspace,
  ReadWorkspaceOptions,
} from "./notebook-workspace"
export {
  adminDids,
  foundNotebookWorkspace,
  GENESIS_MAP,
  genesisClaims,
  memberIdFor,
  putGenesis,
  readNotebookWorkspace,
  resourceIdFor,
  workspaceIdFor,
} from "./notebook-workspace"

export {
  authorizationContext,
  CAPABILITY_MAP,
  issueOwnerRoot,
  OWNER_ROOT_DEPTH,
  OWNER_ROOT_TTL_MS,
  ownerHoldsRoot,
  putCapability,
  readCapabilities,
} from "./capabilities"

export type { FoundedKeys, FoundKeysOptions, KeyAccess, NotebookKeys, ReadKeysOptions } from "./notebook-keys"
export {
  EPOCH_MAP,
  foundNotebookKeys,
  KEYRING_MAP,
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  restoreDomainAdmin,
  sealedKeyId,
  storedEpochRecords,
  storedSealedKeys,
} from "./notebook-keys"

export type { Admission, AdmitOptions, InviteOptions, RedeemOptions } from "./admission"
export type { CancelInvitationOptions, InvitationMatch } from "./admission"
export {
  admitFromRedemption,
  findOwnRedemption,
  cancelInvitation,
  findOwnerRoot,
  grantedInvitationIds,
  hasAdmittedMembers,
  hasOutstandingInvitations,
  invitationRevocationsInDoc,
  withdrawnInvitations,
  INVITATION_TTL_MS,
  invitationsInDoc,
  inviteToNotebook,
  matchInvitation,
  MEMBER_GRANT_TTL_MS,
  pendingRedemptions,
  redeemIntoNotebook,
  redemptionsInDoc,
} from "./admission"

export {
  forgetInvitationCode,
  forgetNotebookCodes,
  pruneInvitationCodes,
  recallInvitationCode,
  rememberInvitationCode,
} from "./invitation-secrets"

export type { NoteSyncOptions } from "./note-sync"
export { createNoteSyncEngine, noteResourceId, notebookKeyProvider } from "./note-sync"

export type { JoinSnapshotOptions, NoteSource } from "./note-snapshots"
export { snapshotNotesForJoiner, snapshotsForNote } from "./note-snapshots"

export type {
  AdmissionPlan,
  NoteLoader,
  NoteRef,
  NoteTask,
  NoteTaskState,
  PlanOptions,
  PlanProgress,
  RunOptions,
} from "./admission-plan"
export {
  clearPlan,
  completeTask,
  domainsOf,
  isComplete,
  loadPlan,
  notesNeedingMaterialisation,
  pendingTasks,
  planAdmission,
  progressOf,
  runAdmissionPlan,
  savePlan,
  unreadableNotes,
} from "./admission-plan"

export type { JoinSnapshotResult } from "./note-snapshots"
export { hasNoOperations } from "./note-snapshots"

export type { NoteEngineOptions } from "./note-relay"
export type { RelaySettings } from "./note-relay"
export {
  closeRelayConnection,
  configureRelay,
  createNoteEngine,
  encryptedSyncEnabled,
  liveKeys,
  relayConnection,
  relaySettings,
  relayWatch,
  storedBaseline,
  storedCursor,
} from "./note-relay"

export type {
  BaselineMemo,
  SyncSession,
  SyncSessionOptions,
  SyncSessionStatus,
  RelayReachability,
  RelayWatch,
} from "./sync-session"
export { openSyncSession } from "./sync-session"

export type {
  DirectoryChannel,
  DirectoryReplicaOptions,
  ReplicaDevice,
  TreeReplicaOptions,
} from "./replicas"
export {
  createDirectoryReplica,
  createTreeReplica,
  directoryChannel,
  treeResourceId,
} from "./replicas"

export type { NoteAdmissionOptions, NoteAdmissionResult, NoteOutcome } from "./admit-notes"
export { markCovered, noteRefsFor, runNoteAdmission } from "./admit-notes"

export type { RewrapNoteOptions, Sealer, SealNoteOptions } from "./admission-sealer"
export { createSealer, inlineSealer, workerSealer } from "./admission-sealer"
