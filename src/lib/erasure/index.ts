/**
 * Deletion and cryptographic erasure (milestone M11).
 *
 * The bytes are on someone else's disk, so deletion means destroying keys and
 * leaving the ciphertext as noise. Everything here is about being precise about
 * what that does and does not guarantee.
 */

export type { ErasureScope } from "./scope"
export { erasureScope, nextCleanBoundary, prefixTargets } from "./scope"

export type {
  ErasureBody,
  ErasureProgress,
  ErasureRecord,
  ErasureScopeKind,
  ErasureTier,
  OrderErasureOptions,
} from "./tombstone"
export {
  ERASURE_VERSION,
  erasureBytes,
  erasureProgress,
  orderErasure,
  verifyErasure,
} from "./tombstone"

export type { ErasureImpact, ImpactInput } from "./impact"
export { assessErasure, ErasureRefused, requireClean, requirePreservation } from "./impact"

export type {
  CiphertextRequest,
  EraseHistoryOptions,
  EraseOptions,
  ErasureOutcome,
  NoteErasability,
} from "./erase"
export { applyErasure, eraseDomain, eraseHistory, eraseNote, noteErasability } from "./erase"
