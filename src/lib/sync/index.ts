/**
 * Signed updates and sync (milestone M4).
 *
 * A plaintext Yjs document stays local; the wire carries only signed, encrypted
 * envelopes. Catch-up replays original envelopes rather than a synthesised
 * diff, so every update stays independently verifiable against an untrusted
 * responder.
 */

export type { Envelope, EnvelopeHeader, EnvelopeKind, MakeEnvelopeOptions } from "./envelope"
export {
  ENVELOPE_VERSION,
  envelopeHeader,
  envelopeSignedBytes,
  headerBytes,
  isEnvelopeShaped,
  makeEnvelope,
  openEnvelope,
  verifyEnvelopeSignature,
} from "./envelope"

export type { DeliveryVector } from "./envelope-log"
export { EnvelopeLog } from "./envelope-log"

export type { UpdateAuthorshipResult } from "./update-guard"
export {
  checkUpdateAuthorship,
  updateDeleteSetClientIds,
  updateStructClientIds,
} from "./update-guard"

export type { Transport } from "./transport"
export { OfflineTransport } from "./transport"

export { MemoryRelay, RelayTransport } from "./memory-relay"

export type {
  AuthorInfo,
  AuthorResolver,
  EpochKeyProvider,
  RejectionReason,
  SyncEngineOptions,
  SyncResult,
  SyncStats,
  WritePolicy,
} from "./sync-engine"
export { LOCAL_ORIGIN, memoryCursorStore, REMOTE_ORIGIN, SyncEngine } from "./sync-engine"
export type { ResumeResult, SyncCursor, SyncCursorStore } from "./sync-engine"

export type { DirectoryAuthorityOptions } from "./directory-resolver"
export { DirectoryAuthorResolver, DirectoryMembershipPolicy } from "./directory-resolver"

export type { LockBackend, SingleWriterOptions, WriterStatus } from "./single-writer"
export { SingleWriterGuard, webLockBackend, writerLockName } from "./single-writer"
