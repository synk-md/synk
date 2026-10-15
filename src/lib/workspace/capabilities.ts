/**
 * Capability tokens carried in the notebook's index document.
 *
 * The owner's own root is issued at founding, and it is not ceremony: a chain
 * is only valid when it reaches a root the owner issued, so without one the
 * owner holds no admin anywhere and every admin-gated check - signing an epoch
 * record above all - refuses them. Ownership establishes *who* may issue a
 * root; the root is what they actually hold.
 *
 * Tokens are stored by cid and re-verified on read. Any peer can write to this
 * map and nothing here grants anything: a forged token either fails its
 * signature or fails to chain to the owner.
 */

import * as Y from "yjs"

import {
  CapabilityStore,
  decodeCapability,
  issueCapability,
  type AuthorizationContext,
  type Capability,
  type Revocation,
} from "@/lib/authz"
import type { SigningKey } from "@/lib/crypto"
import { readDirectory } from "@/lib/directory"

export const CAPABILITY_MAP = "workspace:capabilities"
/** Withdrawn grants, by the cid they withdraw. Verified against the chain on read. */
export const REVOCATION_MAP = "workspace:revocations"

/**
 * How long an owner's root lasts. Long, because it expiring locks the owner out
 * of their own notebook, and nothing renews it yet.
 */
export const OWNER_ROOT_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** Delegations the owner may pass on. Deep enough for admin → member → leaf. */
export const OWNER_ROOT_DEPTH = 8

function capabilityMap(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(CAPABILITY_MAP)
}

export function putCapability(doc: Y.Doc, capability: Capability): void {
  capabilityMap(doc).set(capability.cid, capability.token)
}

export function putRevocation(doc: Y.Doc, revocation: Revocation): void {
  doc.getMap<Revocation>(REVOCATION_MAP).set(revocation.cid, revocation)
}

/**
 * Resolves an author to the device whose grant it writes under: itself, or -
 * for a device linked by one of the member's own - the device that linked it.
 *
 * Read from the verified directory at each check, so a link whose parent is
 * removed, or whose record does not verify, gives nothing to write under.
 */
export function linkedPrincipal(directory: Y.Doc, owner: string, workspace: string) {
  return async (author: string): Promise<string> => {
    const verified = await readDirectory(directory, [owner], { workspace })
    const device = verified.devices.find((entry) => entry.record.did === author)
    return device?.kind === "linked" ? device.link.parent : author
  }
}

/** Decode every token present. Malformed ones are dropped, not thrown on. */
export async function readCapabilities(doc: Y.Doc): Promise<Capability[]> {
  const out: Capability[] = []
  for (const [cid, token] of capabilityMap(doc).entries()) {
    if (typeof token !== "string") continue
    try {
      const capability = await decodeCapability(token)
      // Filed under a cid other than its own is a misfiled or hostile entry.
      if (capability.cid === cid) out.push(capability)
    } catch {
      // Not a capability. The map is writable by any peer.
    }
  }
  return out
}

/**
 * Build the context checks run against.
 *
 * `CapabilityStore.add` verifies each signature before accepting it, so a
 * garbage token never reaches the chain walk.
 */
export async function authorizationContext(
  doc: Y.Doc,
  owner: string,
  now: number = Date.now(),
): Promise<AuthorizationContext> {
  // The owner's own linked devices act as the owner; what one signed before it
  // was unlinked stays valid if the owner kept it.
  const directory = await readDirectory(doc, [owner], { now })
  const store = new CapabilityStore(owner, { deputies: directory.deputies, kept: directory.kept })
  for (const capability of await readCapabilities(doc)) await store.add(capability)
  // After every capability, since a revocation is judged against its chain.
  // The store refuses one that its issuer was not entitled to make.
  for (const revocation of doc.getMap<Revocation>(REVOCATION_MAP).values()) {
    await store.revoke(revocation, now)
  }
  return store.context(now)
}

/**
 * The owner's root admin capability: issued by the owner, to the owner, with no
 * proof behind it. `verifyChain` accepts a root only when its issuer is the
 * owner, which is exactly what makes this one valid and a stranger's identical
 * token worthless.
 */
export async function issueOwnerRoot(options: {
  signingKey: SigningKey
  owner: string
  resource: string
  now?: number
  ttlMs?: number
}): Promise<Capability> {
  const now = options.now ?? Date.now()
  return issueCapability({
    signingKey: options.signingKey,
    issuer: options.owner,
    audience: options.owner,
    resource: options.resource,
    ability: "admin",
    depth: OWNER_ROOT_DEPTH,
    proof: null,
    notBefore: now,
    expiresAt: now + (options.ttlMs ?? OWNER_ROOT_TTL_MS),
  })
}

/** Does this document already carry a usable root for the owner? */
export async function ownerHoldsRoot(
  doc: Y.Doc,
  owner: string,
  resource: string,
  now: number = Date.now(),
): Promise<boolean> {
  for (const capability of await readCapabilities(doc)) {
    const { iss, aud, rsc, can, prf, nbf, exp } = capability.payload
    if (iss !== owner || aud !== owner || prf !== null) continue
    if (rsc !== resource || can !== "admin") continue
    if (now < nbf || now >= exp) continue
    return true
  }
  return false
}
