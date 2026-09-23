/**
 * Revoking a self-linked device. A member who loses their phone can invalidate
 * it from their laptop without an admin - the self-service path that created
 * the link should be able to undo it.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid, type DeviceLink, type MemberDevice } from "@/lib/identity"

export const LINK_REVOCATION_VERSION = 1

export interface LinkRevocationBody {
  v: typeof LINK_REVOCATION_VERSION
  /** `did:key` of the linked device being invalidated. */
  did: string
  /** Member the link belonged to. Copied from the link, never chosen here. */
  member: string
  workspace: string
  /** `did:key` of the device performing the revocation. */
  revoker: string
  reason?: string
  revokedAt: number
}

export interface LinkRevocation extends LinkRevocationBody {
  sig: string
}

export function linkRevocationBytes(body: LinkRevocationBody): Bytes {
  return utf8(
    [
      "synk/link-revocation/v1",
      String(body.v),
      body.did,
      body.member,
      body.workspace,
      body.revoker,
      body.reason ?? "",
      String(body.revokedAt),
    ].join("\n"),
  )
}

export interface RevokeLinkOptions {
  signingKey: SigningKey
  /** The revoking device - must be admin-admitted for this member. */
  revoker: string
  link: DeviceLink
  reason?: string
  revokedAt?: number
}

export async function revokeLink(options: RevokeLinkOptions): Promise<LinkRevocation> {
  const revokerKey = publicKeyFromDid(options.revoker, "ed25519")
  if (toBase64Url(revokerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("revoker does not match the supplied signing key")
  }
  if (options.revoker === options.link.did) {
    throw new Error("a linked device cannot revoke itself")
  }

  const body: LinkRevocationBody = {
    v: LINK_REVOCATION_VERSION,
    did: options.link.did,
    member: options.link.member,
    workspace: options.link.workspace,
    revoker: options.revoker,
    revokedAt: options.revokedAt ?? Date.now(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(linkRevocationBytes(body))) }
}

/**
 * Entitlement is the part that matters: a signature alone would let a stranger
 * unlink someone else's phone. The revoker must be an admin-admitted device of
 * the same member.
 */
export async function verifyLinkRevocation(
  revocation: LinkRevocation,
  link: DeviceLink,
  memberDevices: readonly MemberDevice[],
): Promise<boolean> {
  try {
    if (revocation.v !== LINK_REVOCATION_VERSION) return false
    if (revocation.did !== link.did) return false
    if (revocation.member !== link.member) return false
    if (revocation.workspace !== link.workspace) return false

    const entitled = memberDevices.some(
      (device) =>
        device.kind === "admitted" &&
        device.record.did === revocation.revoker &&
        device.admission.member === link.member,
    )
    if (!entitled) return false

    const { sig, ...body } = revocation
    return await verifySignature(
      publicKeyFromDid(revocation.revoker, "ed25519"),
      linkRevocationBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/** Device DIDs whose links have been validly revoked. */
export async function revokedLinkDids(
  revocations: readonly LinkRevocation[],
  devices: readonly MemberDevice[],
): Promise<Set<string>> {
  const revoked = new Set<string>()
  for (const revocation of revocations) {
    const target = devices.find(
      (device) => device.kind === "linked" && device.record.did === revocation.did,
    )
    if (!target || target.kind !== "linked") continue
    if (await verifyLinkRevocation(revocation, target.link, devices)) revoked.add(revocation.did)
  }
  return revoked
}

/** The member's device set with revoked links removed. */
export async function withoutRevokedLinks(
  devices: readonly MemberDevice[],
  revocations: readonly LinkRevocation[],
): Promise<MemberDevice[]> {
  const revoked = await revokedLinkDids(revocations, devices)
  return devices.filter((device) => !revoked.has(device.record.did))
}
