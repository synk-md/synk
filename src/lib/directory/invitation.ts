/**
 * Invitation flow for admitting a brand-new person without trust-on-first-use.
 *
 * An admin generates a single-use high-entropy secret and hands it to the
 * invitee out of band. Both sides derive the same ephemeral keypair from it.
 * The admin publishes a signed invitation naming the public half; the invitee
 * signs their real device keys with the private half. That proof does two jobs
 * at once: it demonstrates possession of the secret, and it binds the invitee's
 * real keys so a channel attacker cannot substitute their own.
 *
 * Neither party needs to be online at the same time - the invitation and the
 * redemption are both records that sit in the directory until collected.
 *
 * Modelled on the Keybase Seitan construction, implemented directly.
 */

import { base32crockford } from "@scure/base"
import {
  deriveKey,
  fromBase64Url,
  importSigningKey,
  randomBytes,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import {
  createDeviceAdmission,
  didFromSigningKey,
  publicKeyFromDid,
  verifyDeviceRecord,
  type DeviceAdmission,
  type DeviceRecord,
} from "@/lib/identity"

export const INVITATION_VERSION = 1
export const REDEMPTION_VERSION = 1

/** 128 bits. Brute force is infeasible, which is what makes rate limiting defence in depth rather than the control. */
export const INVITATION_SECRET_BYTES = 16

/** Default validity. Short enough that a leaked secret has a bounded life. */
export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const SECRET_GROUP = 5

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

/**
 * Crockford base32: case-insensitive, and excludes I, L, O and U so it survives
 * being read aloud, typed, or copied out of a chat message.
 */
export function formatInvitationSecret(secret: Bytes): string {
  const encoded = base32crockford.encode(secret)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += SECRET_GROUP) {
    groups.push(encoded.slice(i, i + SECRET_GROUP))
  }
  return groups.join("-")
}

/** Tolerant of case, spacing and grouping dashes - humans retype these. */
export function parseInvitationSecret(text: string): Bytes {
  const cleaned = text.replace(/[\s-]/g, "").toUpperCase()
  if (!cleaned) throw new Error("invitation secret is empty")
  let bytes: Bytes
  try {
    bytes = base32crockford.decode(cleaned)
  } catch {
    throw new Error("invitation secret is not valid base32")
  }
  if (bytes.length !== INVITATION_SECRET_BYTES) {
    throw new Error(
      `invitation secret must be ${INVITATION_SECRET_BYTES} bytes, got ${bytes.length}`,
    )
  }
  return bytes
}

export function generateInvitationSecret(): { secret: Bytes; text: string } {
  const secret = randomBytes(INVITATION_SECRET_BYTES)
  return { secret, text: formatInvitationSecret(secret) }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Both sides derive this from the same secret. The admin keeps only the public
 * half; the invitee reconstructs the private half to sign their redemption.
 */
export async function deriveInvitationKey(secret: Bytes): Promise<SigningKey> {
  if (secret.length !== INVITATION_SECRET_BYTES) {
    throw new Error(`invitation secret must be ${INVITATION_SECRET_BYTES} bytes`)
  }
  return importSigningKey(await deriveKey(secret, "synk/invitation/v1"), { extractable: true })
}

/**
 * The invitation's identity is the `did:key` of its derived public key. Nothing
 * separate to allocate, and an invitation cannot be confused with another.
 */
export async function invitationIdFromSecret(secret: Bytes): Promise<string> {
  return didFromSigningKey((await deriveInvitationKey(secret)).publicKey)
}

// ---------------------------------------------------------------------------
// The invitation record (admin-signed)
// ---------------------------------------------------------------------------

export interface InvitationBody {
  v: typeof INVITATION_VERSION
  /** `did:key` of the key derived from the secret. */
  invitationId: string
  /** Member identity the invitee will be admitted under. */
  member: string
  /** Human label, attested by the admin at invitation time. */
  label: string
  workspace: string
  admin: string
  issuedAt: number
  expiresAt: number
}

export interface Invitation extends InvitationBody {
  sig: string
}

export function invitationBytes(body: InvitationBody): Bytes {
  return utf8(
    [
      "synk/invitation/v1",
      String(body.v),
      body.invitationId,
      body.member,
      body.label,
      body.workspace,
      body.admin,
      String(body.issuedAt),
      String(body.expiresAt),
    ].join("\n"),
  )
}

export interface CreateInvitationOptions {
  adminSigningKey: SigningKey
  adminDid: string
  /** The secret handed to the invitee out of band. */
  secret: Bytes
  member: string
  label: string
  workspace: string
  issuedAt?: number
  ttlMs?: number
}

/**
 * Issue an invitation. Admin-only by construction - there is no entry point
 * that produces one without an admin signing key.
 *
 * `member` and `label` are fixed here, at invitation time, so the grant that
 * follows copies an admin's attestation rather than trusting anything the
 * invitee sends.
 */
export async function createInvitation(options: CreateInvitationOptions): Promise<Invitation> {
  const { adminSigningKey, adminDid, secret, member, label, workspace } = options
  if (!member.trim()) throw new Error("an invitation must name a member")
  if (!label.trim()) throw new Error("an invitation must carry a non-empty human label")

  const adminPublicKey = publicKeyFromDid(adminDid, "ed25519")
  if (toBase64Url(adminPublicKey) !== toBase64Url(adminSigningKey.publicKey)) {
    throw new Error("adminDid does not match the supplied admin signing key")
  }

  const issuedAt = options.issuedAt ?? Date.now()
  const body: InvitationBody = {
    v: INVITATION_VERSION,
    invitationId: await invitationIdFromSecret(secret),
    member: member.trim(),
    label: label.trim(),
    workspace,
    admin: adminDid,
    issuedAt,
    expiresAt: issuedAt + (options.ttlMs ?? DEFAULT_INVITATION_TTL_MS),
  }
  return { ...body, sig: toBase64Url(await adminSigningKey.sign(invitationBytes(body))) }
}

export interface VerifyInvitationOptions {
  workspace?: string
  /** Injectable for tests and for evaluating an invitation as of a past moment. */
  now?: number
}

export async function verifyInvitation(
  invitation: Invitation,
  trustedAdminDids: readonly string[],
  options: VerifyInvitationOptions = {},
): Promise<boolean> {
  try {
    if (invitation.v !== INVITATION_VERSION) return false
    if (!invitation.member.trim() || !invitation.label.trim()) return false
    if (!trustedAdminDids.includes(invitation.admin)) return false
    if (options.workspace !== undefined && invitation.workspace !== options.workspace) return false

    const now = options.now ?? Date.now()
    if (now >= invitation.expiresAt) return false

    // Must be a well-formed signing DID, or the redemption check below would
    // have nothing to verify against.
    publicKeyFromDid(invitation.invitationId, "ed25519")

    const adminPublicKey = publicKeyFromDid(invitation.admin, "ed25519")
    const { sig, ...body } = invitation
    return await verifySignature(adminPublicKey, invitationBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

export function isInvitationExpired(invitation: Invitation, now = Date.now()): boolean {
  return now >= invitation.expiresAt
}

// ---------------------------------------------------------------------------
// The redemption proof (invitee-signed, with the derived key)
// ---------------------------------------------------------------------------

export interface RedemptionBody {
  v: typeof REDEMPTION_VERSION
  invitationId: string
  /** The invitee's real signing key. */
  did: string
  sealingDid: string
  clientId: number
  redeemedAt: number
}

export interface Redemption extends RedemptionBody {
  /** The invitee's self-signed record, proving possession of the real keys. */
  record: DeviceRecord
  /** Signature by the key derived from the invitation secret. */
  sig: string
}

export function redemptionBytes(body: RedemptionBody): Bytes {
  return utf8(
    [
      "synk/invitation-redemption/v1",
      String(body.v),
      body.invitationId,
      body.did,
      body.sealingDid,
      String(body.clientId),
      String(body.redeemedAt),
    ].join("\n"),
  )
}

export interface RedeemInvitationOptions {
  /** The secret, as received out of band. */
  secret: Bytes
  /** The invitee's own freshly generated device record. */
  record: DeviceRecord
  redeemedAt?: number
}

/**
 * Produce the redemption proof.
 *
 * The signed bytes cover the invitee's real keys, which is what removes
 * trust-on-first-use: an attacker who sees the redemption in transit cannot
 * swap in their own device record, because the signature is under a key only
 * the secret holder can derive.
 */
export async function redeemInvitation(options: RedeemInvitationOptions): Promise<Redemption> {
  const { secret, record } = options
  if (!(await verifyDeviceRecord(record))) {
    throw new Error("cannot redeem with a device record that does not verify")
  }
  const invitationKey = await deriveInvitationKey(secret)
  const body: RedemptionBody = {
    v: REDEMPTION_VERSION,
    invitationId: didFromSigningKey(invitationKey.publicKey),
    did: record.did,
    sealingDid: record.sealingDid,
    clientId: record.clientId,
    redeemedAt: options.redeemedAt ?? Date.now(),
  }
  return { ...body, record, sig: toBase64Url(await invitationKey.sign(redemptionBytes(body))) }
}

/**
 * Verify a redemption against the invitation it claims.
 *
 * The invitation is required: a redemption alone says nothing, since its
 * signature is only meaningful against the public key the admin published.
 */
export async function verifyRedemption(
  redemption: Redemption,
  invitation: Invitation,
  options: { now?: number } = {},
): Promise<boolean> {
  try {
    if (redemption.v !== REDEMPTION_VERSION) return false
    if (redemption.invitationId !== invitation.invitationId) return false

    // The proof and the record must describe the same keys, or the binding
    // would cover something other than what is being admitted.
    if (redemption.did !== redemption.record.did) return false
    if (redemption.sealingDid !== redemption.record.sealingDid) return false
    if (redemption.clientId !== redemption.record.clientId) return false
    if (!(await verifyDeviceRecord(redemption.record))) return false

    // Redeeming after expiry is refused even if a grant is attempted later.
    const now = options.now ?? Date.now()
    if (redemption.redeemedAt >= invitation.expiresAt) return false
    if (now >= invitation.expiresAt) return false

    const invitationPublicKey = publicKeyFromDid(invitation.invitationId, "ed25519")
    // The record travels alongside the proof but is not part of the signed
    // bytes - it is bound by the did/sealingDid/clientId fields checked above.
    const body: RedemptionBody = {
      v: redemption.v,
      invitationId: redemption.invitationId,
      did: redemption.did,
      sealingDid: redemption.sealingDid,
      clientId: redemption.clientId,
      redeemedAt: redemption.redeemedAt,
    }
    return await verifySignature(
      invitationPublicKey,
      redemptionBytes(body),
      fromBase64Url(redemption.sig),
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The grant (admin-gated)
// ---------------------------------------------------------------------------

export interface GrantFromRedemptionOptions {
  adminSigningKey: SigningKey
  adminDid: string
  invitation: Invitation
  redemption: Redemption
  /** Admins this grant will accept the invitation as having come from. */
  trustedAdminDids: readonly string[]
  /**
   * Redemptions already recorded for this invitation, from the directory.
   * Single-use is enforced here: a second redemption naming a *different*
   * device is refused.
   */
  priorRedemptions?: readonly Redemption[]
  now?: number
}

/**
 * Turn a verified redemption into a `DeviceAdmission`.
 *
 * The last admin-gated step. `member` and `label` come from the invitation the
 * admin signed, never from the redemption, so an invitee cannot choose the
 * identity or the name they are admitted under.
 *
 * Single-use is enforced by comparing against redemptions already in the
 * directory. Because the directory is an untrusted-merge Yjs structure, two
 * admins granting concurrently can both succeed; that is surfaced as a conflict
 * rather than prevented, in the same eventually-consistent spirit as revocation.
 */
export async function grantFromRedemption(
  options: GrantFromRedemptionOptions,
): Promise<DeviceAdmission> {
  const { adminSigningKey, adminDid, invitation, redemption, trustedAdminDids } = options
  const now = options.now ?? Date.now()

  if (!(await verifyInvitation(invitation, trustedAdminDids, { now }))) {
    throw new Error("invitation is invalid, expired, or not from a trusted admin")
  }
  if (!(await verifyRedemption(redemption, invitation, { now }))) {
    throw new Error("redemption proof does not verify against this invitation")
  }

  const spent = (options.priorRedemptions ?? []).filter(
    (prior) =>
      prior.invitationId === invitation.invitationId && prior.did !== redemption.did,
  )
  if (spent.length > 0) {
    throw new Error(
      `invitation ${invitation.invitationId} was already redeemed by a different device`,
    )
  }

  return createDeviceAdmission({
    adminSigningKey,
    adminDid,
    record: redemption.record,
    member: invitation.member,
    label: invitation.label,
    workspace: invitation.workspace,
    issuedAt: now,
  })
}
