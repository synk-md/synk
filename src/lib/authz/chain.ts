/**
 * A general chain walk to the resource owner, of arbitrary depth, checking
 * attenuation at every link. Nothing in it knows about roles.
 *
 * Failures are returned rather than thrown - the result is a decision, not an
 * exception - and they name the rule that failed.
 */

import { checkAttenuation, abilitySatisfies, resourceContains } from "./attenuation"
import {
  isTimeValid,
  verifyCapabilitySignature,
  type Ability,
  type Capability,
} from "./capability"

/** Without a bound, a long chain is cheap unbounded signature work. */
export const MAX_CHAIN_DEPTH = 16

export type DenialReason =
  | "no-capability"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "revoked"
  | "insufficient-ability"
  | "resource-mismatch"
  | "attenuation"
  | "broken-proof"
  | "root-not-owner"
  | "chain-too-long"
  | "cycle"

export interface AuthorizationResult {
  authorized: boolean
  reason?: DenialReason
  detail?: string
  /** Root-first, when authorized. Useful for showing where authority came from. */
  chain?: Capability[]
}

/** Everything a check needs to resolve proofs and judge validity. */
export interface AuthorizationContext {
  /** Capabilities available by cid. Usually the verified directory's view. */
  proofs: ReadonlyMap<string, Capability>
  /** The resource owner. A root must be issued by this principal. */
  owner: string
  now: number
  /** Revoked cids. Eventually consistent - see `revocation.ts`. */
  revoked?: ReadonlySet<string>
  /** Devices that act as another principal: an admin's own linked devices act as that admin. */
  deputies?: ReadonlyMap<string, string>
  /**
   * What former deputies issued that stays valid, by cid or signature. Such a
   * record acts for the owner, as the deputy did when it signed it.
   */
  kept?: ReadonlySet<string>
}

/** Who a principal holds capabilities as. */
export function principalFor(did: string, context: AuthorizationContext): string {
  return context.deputies?.get(did) ?? did
}

function deny(reason: DenialReason, detail?: string): AuthorizationResult {
  return detail === undefined ? { authorized: false, reason } : { authorized: false, reason, detail }
}

/** One link in isolation. Attenuation is a relation, checked by the walk. */
async function checkLink(
  capability: Capability,
  context: AuthorizationContext,
): Promise<AuthorizationResult> {
  if (context.revoked?.has(capability.cid)) {
    return deny("revoked", `capability ${capability.cid} was revoked`)
  }
  if (!(await verifyCapabilitySignature(capability))) {
    return deny("bad-signature", `signature does not verify under ${capability.payload.iss}`)
  }
  if (context.now < capability.payload.nbf) return deny("not-yet-valid")
  if (context.now >= capability.payload.exp) return deny("expired")
  return { authorized: true }
}

/**
 * Walk to a root, which is valid only if the owner issued it - the single place
 * ownership enters the model.
 */
export async function verifyChain(
  leaf: Capability,
  context: AuthorizationContext,
): Promise<AuthorizationResult> {
  const chain: Capability[] = []
  const seen = new Set<string>()
  let current = leaf

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    // Unreachable: attenuation makes cycles impossible, since depth strictly
    // decreases. Here so a corrupt proof map terminates rather than spins.
    if (seen.has(current.cid)) return deny("cycle", `capability ${current.cid} revisited`)
    seen.add(current.cid)

    const link = await checkLink(current, context)
    if (!link.authorized) return link
    chain.push(current)

    if (current.payload.prf === null) {
      // A root is only a root if the owner issued it.
      if (current.payload.iss === context.owner) return { authorized: true, chain: chain.reverse() }
      // Or an owner before them, whose root the owner kept on taking over - and
      // then only for what was granted under it before: every link above it
      // must have been kept too, so nothing new is built on it, and on its
      // own it is nothing.
      if (context.kept?.has(current.cid) && chain.length > 1 && chain.slice(0, -1).every((link) => context.kept?.has(link.cid))) {
        return { authorized: true, chain: chain.reverse() }
      }
      return deny("root-not-owner", `root was issued by ${current.payload.iss}, not the owner ${context.owner}`)
    }

    const parent = context.proofs.get(current.payload.prf)
    if (!parent) {
      return deny("broken-proof", `proof ${current.payload.prf} is not available`)
    }
    // A deputy issues as the principal it acts for, so its grants rest on that
    // principal's. A kept grant rests on whatever its proof names: it was a
    // deputy's, of an owner who is gone, and stands as it was signed.
    const issuer =
      current.payload.iss === parent.payload.aud
        ? current.payload.iss
        : context.deputies?.get(current.payload.iss) ??
          (context.kept?.has(current.cid) ? parent.payload.aud : current.payload.iss)
    const failure = checkAttenuation({ ...current.payload, iss: issuer }, parent.payload)
    if (failure) return deny("attenuation", `${failure.rule}: ${failure.detail}`)
    current = parent
  }

  return deny("chain-too-long", `exceeded ${String(MAX_CHAIN_DEPTH)} links`)
}

export interface AuthorizationQuery {
  /** The principal being checked. Opaque - device or group. */
  principal: string
  resource: string
  ability: Ability
}

/**
 * Tries every covering capability, not just the first: a principal may hold
 * several, and an expired or revoked one must not mask a good one.
 */
export async function authorize(
  query: AuthorizationQuery,
  context: AuthorizationContext,
): Promise<AuthorizationResult> {
  const principal = principalFor(query.principal, context)
  const candidates = [...context.proofs.values()].filter(
    (capability) =>
      capability.payload.aud === principal &&
      abilitySatisfies(capability.payload.can, query.ability) &&
      resourceContains(capability.payload.rsc, query.resource),
  )

  if (candidates.length === 0) {
    return deny(
      "no-capability",
      `${query.principal} holds no ${query.ability} capability covering ${query.resource}`,
    )
  }

  let lastFailure: AuthorizationResult | undefined
  for (const candidate of candidates) {
    const result = await verifyChain(candidate, context)
    if (result.authorized) return result
    lastFailure = result
  }
  return lastFailure ?? deny("no-capability")
}

/** Convenience for call sites that only need the decision. */
export async function isAuthorized(
  query: AuthorizationQuery,
  context: AuthorizationContext,
): Promise<boolean> {
  return (await authorize(query, context)).authorized
}

/** Every capability whose validity window currently includes `now`. */
export function activeCapabilities(
  capabilities: Iterable<Capability>,
  now: number,
): Capability[] {
  return [...capabilities].filter((capability) => isTimeValid(capability.payload, now))
}
