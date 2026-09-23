/**
 * Authorization (milestone M7).
 *
 * Per-resource capabilities: standalone signed delegations verified as a chain
 * from the resource owner to the principal being checked. No membership
 * document, no roster CRDT, nothing whose concurrent merge would need to be
 * made safe.
 */

export type {
  Ability,
  Capability,
  CapabilityHeader,
  CapabilityPayload,
  IssueCapabilityOptions,
} from "./capability"
export {
  CAPABILITY_VERSION,
  capabilityCid,
  decodeCapability,
  issueCapability,
  isTimeValid,
  verifyCapabilitySignature,
} from "./capability"

export type { AttenuationFailure } from "./attenuation"
export {
  abilitySatisfies,
  checkAttenuation,
  isWeakerOrEqual,
  resourceContains,
} from "./attenuation"

export type {
  AuthorizationContext,
  AuthorizationQuery,
  AuthorizationResult,
  DenialReason,
} from "./chain"
export { activeCapabilities, authorize, isAuthorized, MAX_CHAIN_DEPTH, verifyChain } from "./chain"

export type { Revocation, RevocationBody, RevokeOptions } from "./revocation"
export { chainIssuers, REVOCATION_VERSION, revocationBytes, revokeCapability, verifyRevocation } from "./revocation"

export type { CandidateReader, ContextSource, ReaderGateResult } from "./enforcement"
export {
  canAdminister,
  canRead,
  CapabilityWritePolicy,
  gateReaders,
  requireReaders,
} from "./enforcement"

export { CapabilityStore } from "./store"
