/**
 * Identity and device keys (milestone M2).
 *
 * A device generates Ed25519 and X25519 keys on first run, persists them
 * non-extractably, and publishes a self-signed record. Authority to use them in
 * a workspace comes from an admin admission or a member's own device link.
 */

export {
  deviceFingerprint,
  FINGERPRINT_BITS,
  FINGERPRINT_CHARS,
  FINGERPRINT_PLACEHOLDER,
  fingerprintsMatch,
} from "./fingerprint"

export type { DidKeyType, DecodedDid } from "./did"
export {
  decodeDid,
  didFromSealingKey,
  didFromSigningKey,
  isValidDid,
  publicKeyFromDid,
} from "./did"

export {
  assertNoClientIdCollision,
  bindDocumentClientId,
  clientIdMatchesDevice,
  deriveClientId,
  MAX_CLIENT_ID,
} from "./client-id"

export type { CreateDeviceRecordOptions, DeviceRecord, DeviceRecordBody } from "./device-record"
export {
  canonicalBytes,
  createDeviceRecord,
  DEVICE_RECORD_VERSION,
  sealingPublicKeyOf,
  signingPublicKeyOf,
  verifyDeviceRecord,
} from "./device-record"

export type { CurrentDevice } from "./current-device"
export {
  currentDevice,
  currentDeviceError,
  initCurrentDevice,
  resetCurrentDevice,
} from "./current-device"

export type { DeviceIdentity } from "./device-identity"
export {
  forgetDeviceIdentity,
  getOrCreateDeviceIdentity,
  resetDeviceIdentityCache,
} from "./device-identity"

export type { StoredClockWatermark, StoredDeviceIdentity } from "./device-store"
export {
  clearClockWatermarks,
  clearStoredDeviceIdentity,
  loadClockWatermark,
  loadStoredDeviceIdentity,
  recordClockWatermark,
  resetDeviceDatabaseConnection,
  saveStoredDeviceIdentity,
} from "./device-store"

export type { ClockDurabilityStatus, TrackDocumentClockOptions } from "./clock-durability"
export {
  assertClockDurability,
  attachDocumentClock,
  checkClockDurability,
  ClockRegressionError,
  currentDocumentClock,
  trackDocumentClock,
} from "./clock-durability"

export type { AdminTrust, TrustedAdmins } from "./admin-trust"
export { adminDidsOf, keptOf, trustsAdmin } from "./admin-trust"

export type {
  AdmittedDevice,
  CreateDeviceAdmissionOptions,
  DeviceAdmission,
  DeviceAdmissionBody,
  VerifyAdmissionOptions,
} from "./device-admission"
export {
  admissionBytes,
  attestedLabel,
  createDeviceAdmission,
  DEVICE_ADMISSION_VERSION,
  verifyAdmittedDevice,
  verifyDeviceAdmission,
} from "./device-admission"

export type { CreateDeviceLinkOptions, DeviceLink, DeviceLinkBody, LinkedDevice } from "./device-link"
export {
  createDeviceLink,
  DEVICE_LINK_VERSION,
  LEAF_DEPTH,
  linkBytes,
  verifyDeviceLink,
  verifyLinkedDevice,
} from "./device-link"

export type { User } from "./user"
export type { MemberDevice, UserLabel } from "./user"
export {
  addDevice,
  admittedDevices,
  canSelfLink,
  createUser,
  findDeviceByClientId,
  findDeviceByDid,
  findUserByDeviceDid,
  hasDevice,
  memberOf,
  recordOf,
  removeDevice,
  userLabel,
  userLabelOrThrow,
  verifyUser,
} from "./user"
