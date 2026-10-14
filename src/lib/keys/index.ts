/**
 * Content encryption, per-notebook keys and epochs (milestone M5).
 *
 * Each key domain - a notebook, or a note promoted to its own key - has a
 * sequence of epoch keys, with a new epoch cut at every membership change.
 * Which epoch keys a member holds is exactly which parts of the history they
 * can decrypt.
 */

export type { EpochKind, EpochReason, EpochRecord, EpochTimeline } from "./epochs"
export {
  deriveChainedEpochKey,
  EPOCH_RECORD_VERSION,
  epochKeyCommitment,
  generateEpochSeed,
  genesisEpoch,
  isReachable,
  reachableEpochs,
  resolveEpochKey,
  segmentStart,
  timelineIsWellFormed,
} from "./epochs"

export type { SealedEpochKey } from "./keyring"
export {
  openEpochKey,
  openKeyring,
  sealEpochKey,
  sealedKeyAad,
  SEALED_EPOCH_KEY_VERSION,
} from "./keyring"

export type { CutEpochResult, KeyRecipient, ReadKeySource, StagedEpoch } from "./domain"
export { FlatKeyring, KeyDomainAdmin, readKeysFor, refreshKeysFor } from "./domain"

export type { PromoteNoteResult } from "./note-promotion"
export { canReadPromotedNote, noteKeyDomain, notePromotionDomain, promoteNote } from "./note-promotion"

export { KeyringEpochProvider } from "./provider"
