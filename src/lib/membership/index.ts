/**
 * Membership lifecycle and revocation (milestone M8).
 *
 * Add, change level and remove, composed from the epoch model (M5), the joiner
 * snapshot (M6) and capabilities (M7). Removal is revoke plus rotate plus
 * reseal: revocation stops accepted writes once it propagates, rotation denies
 * future reads whether it propagates or not.
 */

export type { SignedEpochRecord, TimelineVerification } from "./epoch-timeline"
export {
  epochRecordBytes,
  SIGNED_EPOCH_VERSION,
  signEpochRecord,
  verifySignedEpochRecord,
  verifyTimeline,
} from "./epoch-timeline"

export type {
  FreshnessAssessment,
  FreshnessState,
  FreshnessSummary,
  FreshnessSummaryBody,
  IssueSummaryOptions,
} from "./freshness"
export {
  DEFAULT_MAX_SUMMARY_AGE_MS,
  FRESHNESS_VERSION,
  FreshnessTracker,
  issueFreshnessSummary,
  revocationSetDigest,
  summaryBytes,
  verifyFreshnessSummary,
} from "./freshness"

export type { CurrencyCheck } from "./seal-guard"
export { assertCoversRecipient, assertKeyringCurrent, checkKeyringCurrency } from "./seal-guard"

export type { LinkRevocation, LinkRevocationBody, RevokeLinkOptions } from "./link-revocation"
export {
  LINK_REVOCATION_VERSION,
  linkRevocationBytes,
  revokeLink,
  revokedLinkDids,
  verifyLinkRevocation,
  withoutRevokedLinks,
} from "./link-revocation"

export type {
  ActingAdmin,
  AddMemberOptions,
  AddMemberResult,
  ChangeLevelOptions,
  ChangeLevelResult,
  RemoveMemberOptions,
  RemoveMemberResult,
} from "./lifecycle"
export { addMember, changeMemberLevel, removeMember } from "./lifecycle"
