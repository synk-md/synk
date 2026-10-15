/**
 * Withdrawing an invitation before it expires.
 *
 * M3 left this open: nothing could take an invitation back, so a secret that
 * leaked - or was simply lost, which is the common case - stayed redeemable
 * until its expiry. "I forgot the code" therefore left a live credential in the
 * world with no way to kill it.
 *
 * Its own signed record rather than a mutation, for the same reason capability
 * revocations are: the invitation is an immutable signed token that has already
 * been handed out, and there is nothing to edit.
 *
 * Any admin of the workspace may withdraw any invitation, not only the one who
 * issued it. Being able to take back access is what admin means, and an
 * invitation issued by an admin who has since gone is exactly the one somebody
 * else needs to be able to cancel.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid, trustsAdmin, type AdminTrust } from "@/lib/identity"

import type { Invitation } from "./invitation"

export const INVITATION_REVOCATION_VERSION = 1

export interface InvitationRevocationBody {
  v: typeof INVITATION_REVOCATION_VERSION
  /** The invitation being withdrawn. */
  invitationId: string
  workspace: string
  /** `did:key` of the admin withdrawing it. */
  admin: string
  reason?: string
  revokedAt: number
}

export interface InvitationRevocation extends InvitationRevocationBody {
  sig: string
}

export function invitationRevocationBytes(body: InvitationRevocationBody): Bytes {
  return utf8(
    [
      "synk/invitation-revocation/v1",
      String(body.v),
      body.invitationId,
      body.workspace,
      body.admin,
      body.reason ?? "",
      String(body.revokedAt),
    ].join("\n"),
  )
}

export interface RevokeInvitationOptions {
  signingKey: SigningKey
  admin: string
  invitation: Invitation
  reason?: string
  revokedAt?: number
}

export async function revokeInvitation(
  options: RevokeInvitationOptions,
): Promise<InvitationRevocation> {
  const adminKey = publicKeyFromDid(options.admin, "ed25519")
  if (toBase64Url(adminKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("admin does not match the supplied signing key")
  }
  const body: InvitationRevocationBody = {
    v: INVITATION_REVOCATION_VERSION,
    invitationId: options.invitation.invitationId,
    workspace: options.invitation.workspace,
    admin: options.admin,
    revokedAt: options.revokedAt ?? Date.now(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(invitationRevocationBytes(body))) }
}

/**
 * Authentic, scoped to this invitation, and from a trusted admin.
 *
 * Without the admin check anyone could withdraw anyone's invitation, which is a
 * denial of service against joining - cheap to mount and annoying to diagnose.
 */
export async function verifyInvitationRevocation(
  revocation: InvitationRevocation,
  invitation: Invitation,
  trustedAdminDids: AdminTrust,
): Promise<boolean> {
  try {
    if (revocation.v !== INVITATION_REVOCATION_VERSION) return false
    if (revocation.invitationId !== invitation.invitationId) return false
    if (revocation.workspace !== invitation.workspace) return false
    if (!trustsAdmin(trustedAdminDids, revocation.admin, revocation.sig)) return false

    const { sig, ...body } = revocation
    return await verifySignature(
      publicKeyFromDid(revocation.admin, "ed25519"),
      invitationRevocationBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/** Invitation ids validly withdrawn. Anything unverifiable is simply ignored. */
export async function revokedInvitationIds(
  revocations: readonly InvitationRevocation[],
  invitations: readonly Invitation[],
  trustedAdminDids: AdminTrust,
): Promise<Set<string>> {
  const byId = new Map(invitations.map((invitation) => [invitation.invitationId, invitation]))
  const revoked = new Set<string>()
  for (const revocation of revocations) {
    const invitation = byId.get(revocation.invitationId)
    if (!invitation) continue
    if (await verifyInvitationRevocation(revocation, invitation, trustedAdminDids)) {
      revoked.add(revocation.invitationId)
    }
  }
  return revoked
}
