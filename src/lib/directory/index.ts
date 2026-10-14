/**
 * Directory and invitation (milestone M3).
 *
 * The directory carries member keys, prekeys, invitations and redemptions as
 * Yjs state whose merge is never trusted - every record is signed and every
 * read re-verifies. Prekeys let an epoch key be sealed to a member who is
 * offline. The invitation flow admits a brand-new person without
 * trust-on-first-use and without both parties being online.
 */

export type {
  Invitation,
  InvitationBody,
  Redemption,
  RedemptionBody,
  CreateInvitationOptions,
  RedeemInvitationOptions,
  GrantFromRedemptionOptions,
  VerifyInvitationOptions,
} from "./invitation"
export {
  createInvitation,
  DEFAULT_INVITATION_TTL_MS,
  deriveInvitationKey,
  formatInvitationSecret,
  generateInvitationSecret,
  grantFromRedemption,
  INVITATION_SECRET_BYTES,
  INVITATION_VERSION,
  invitationBytes,
  invitationIdFromSecret,
  isInvitationExpired,
  parseInvitationSecret,
  redeemInvitation,
  REDEMPTION_VERSION,
  redemptionBytes,
  verifyInvitation,
  verifyRedemption,
} from "./invitation"

export type {
  PrekeyBundle,
  PrekeyBundleBody,
  PublishPrekeysOptions,
  SealingTarget,
  VerifyPrekeyBundleOptions,
} from "./prekeys"
export {
  DEFAULT_PREKEY_TTL_MS,
  prekeyBundleBytes,
  PREKEY_BUNDLE_VERSION,
  publishPrekeys,
  remainingOneTimePrekeys,
  selectSealingTarget,
  verifyPrekeyBundle,
} from "./prekeys"

export type { DirectoryReadOptions, VerifiedDirectory } from "./directory"
export {
  DIRECTORY_MAPS,
  putAdmission,
  putDeviceRecord,
  putInvitation,
  putInvitationRevocation,
  putLink,
  putLinkRevocation,
  putRemoval,
  removedDidsUnverified,
  putPrekeyBundle,
  putRedemption,
  rawEntries,
  readDirectory,
  redemptionsFor,
  sealingBundleFor,
} from "./directory"

export type { RateLimitPolicy, RateLimitStatus } from "./rate-limit"
export {
  checkRedemptionRate,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
  recordRedemptionAttempt,
} from "./rate-limit"

export type {
  InvitationRevocation,
  InvitationRevocationBody,
  RevokeInvitationOptions,
} from "./invitation-revocation"
export type { DeviceRemoval, DeviceRemovalBody, RemoveDeviceOptions } from "./device-removal"
export {
  DEVICE_REMOVAL_VERSION,
  deviceRemovalBytes,
  removeDevice,
  verifyDeviceRemoval,
} from "./device-removal"
export {
  INVITATION_REVOCATION_VERSION,
  invitationRevocationBytes,
  revokedInvitationIds,
  revokeInvitation,
  verifyInvitationRevocation,
} from "./invitation-revocation"
