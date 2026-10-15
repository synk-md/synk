/**
 * What an admin keeps of a deputy's work when the deputy stops being one.
 *
 * An admin's own linked devices act as that admin - the owner's phone admits,
 * removes and cuts epochs as the owner. Unlinking the phone ends that, and
 * without this everything it signed would stop verifying: members it admitted
 * would vanish, members it removed would come back. The admin unlinking it
 * names, by signature, what the phone signed that they have seen, and only
 * that stays valid. Whatever the phone signs afterwards is not on the list,
 * however it is dated.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

export const RATIFICATION_VERSION = 1

export interface RatificationBody {
  v: typeof RATIFICATION_VERSION
  workspace: string
  /** `did:key` of the former deputy. */
  device: string
  /** Signatures, or capability cids, of what it signed that stay valid. */
  kept: string[]
  /** `did:key` of the admin keeping them. */
  admin: string
  at: number
}

export interface Ratification extends RatificationBody {
  sig: string
}

export function ratificationBytes(body: RatificationBody): Bytes {
  return utf8(
    [
      "synk/ratification/v1",
      String(body.v),
      body.workspace,
      body.device,
      body.admin,
      String(body.at),
      ...[...body.kept].sort(),
    ].join("\n"),
  )
}

export async function ratify(options: {
  signingKey: SigningKey
  admin: string
  workspace: string
  device: string
  kept: readonly string[]
  at?: number
}): Promise<Ratification> {
  if (toBase64Url(publicKeyFromDid(options.admin, "ed25519")) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("admin does not match the supplied signing key")
  }
  const body: RatificationBody = {
    v: RATIFICATION_VERSION,
    workspace: options.workspace,
    device: options.device,
    kept: [...new Set(options.kept)].sort(),
    admin: options.admin,
    at: options.at ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(ratificationBytes(body))) }
}

/** Only an admin in its own right may keep a deputy's work, never another deputy. */
export async function verifyRatification(
  ratification: Ratification,
  admins: readonly string[],
  options: { workspace?: string } = {},
): Promise<boolean> {
  try {
    if (ratification.v !== RATIFICATION_VERSION) return false
    if (!admins.includes(ratification.admin)) return false
    if (options.workspace !== undefined && ratification.workspace !== options.workspace) return false
    if (!Array.isArray(ratification.kept) || ratification.kept.some((entry) => typeof entry !== "string")) {
      return false
    }
    const { sig, ...body } = ratification
    return await verifySignature(
      publicKeyFromDid(ratification.admin, "ed25519"),
      ratificationBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}
