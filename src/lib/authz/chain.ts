/**
 * The verifier: a general chain walk to the resource owner.
 *
 * Deliberately not hard-coded to owner-to-member. It walks `prf` pointers of
 * arbitrary depth, checking attenuation at every link, and succeeds only when
 * it reaches a root the resource owner issued. Owner → admin → writer → leaf is
 * just the two-link case; nothing in the walk knows about those roles.
 *
 * Failures are returned rather than thrown, and they name the rule that failed.
 * An authorization check runs on attacker-supplied input and its result is a
 * decision, not an exception - but an operator debugging "why was this
 * rejected" needs more than `false`.
 */

import { checkAttenuation, abilitySatisfies, resourceContains } from "./attenuation"
import {
  isTimeValid,
  verifyCapabilitySignature,
  type Ability,
  type Capability,
} from "./capability"

/**
 * Chains longer than this are refused outright. A delegation graph is
 * attacker-supplied; without a bound, a long chain is a cheap way to make every
 * verifier do unbounded signature work.
 */
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
}

function deny(reason: DenialReason, detail?: string): AuthorizationResult {
  return detail === undefined ? { authorized: false, reason } : { authorized: false, reason, detail }
}

/**
 * Validate one capability as a link: signature, validity window, revocation.
 *
 * Not attenuation - that is a relation between two links, checked by the walk.
 */
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
 * Walk a capability to a root the owner issued.
 *
 * Every link is checked in isolation, then against its parent. The walk stops
 * at a root (`prf === null`), which is valid only if the owner issued it -
 * that is the single place ownership enters the model.
 */
export async function verifyChain(
  leaf: Capability,
  context: AuthorizationContext,
): Promise<AuthorizationResult> {
  const chain: Capability[] = []
  const seen = new Set<string>()
  let current = leaf

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    // Defence in depth. Attenuation already makes cycles impossible - depth
    // strictly decreases at every link, so returning to the same capability
    // would need its depth to be below itself - but a corrupt proof map should
    // terminate rather than spin.
    if (seen.has(current.cid)) return deny("cycle", `capability ${current.cid} revisited`)
    seen.add(current.cid)

    const link = await checkLink(current, context)
    if (!link.authorized) return link
    chain.push(current)

    if (current.payload.prf === null) {
      // A root is only a root if the owner issued it.
      if (current.payload.iss !== context.owner) {
        return deny(
          "root-not-owner",
          `root was issued by ${current.payload.iss}, not the owner ${context.owner}`,
        )
      }
      return { authorized: true, chain: chain.reverse() }
    }

    const parent = context.proofs.get(current.payload.prf)
    if (!parent) {
      return deny("broken-proof", `proof ${current.payload.prf} is not available`)
    }
    const failure = checkAttenuation(current.payload, parent.payload)
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
 * Does this principal hold this ability on this resource?
 *
 * Tries every capability addressed to them that could cover the request, and
 * succeeds on the first whose chain reaches the owner. Trying all of them
 * matters: a principal may hold several grants, and an expired or revoked one
 * must not mask a good one.
 */
export async function authorize(
  query: AuthorizationQuery,
  context: AuthorizationContext,
): Promise<AuthorizationResult> {
  const candidates = [...context.proofs.values()].filter(
    (capability) =>
      capability.payload.aud === query.principal &&
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
