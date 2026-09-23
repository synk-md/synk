/**
 * Turning a pile of capabilities into the picture a person is shown.
 *
 * Kept away from React because it is the part that has to be right. Every entry
 * here is produced by the real verifier - a capability that does not chain to
 * the owner does not appear, so the list cannot show access that does not
 * exist, or hide access that does.
 */

import type { IdentityAssurance } from "@/components/custom-ui/identity/identity-badge"
import {
  MAX_CHAIN_DEPTH,
  resourceContains,
  verifyChain,
  type Ability,
  type AuthorizationContext,
  type Capability,
} from "@/lib/authz"

export const ABILITIES: readonly Ability[] = ["read", "write", "admin"]

/**
 * A principal with a name attached.
 *
 * The name is never load-bearing. Capabilities address a `did:key`, and that is
 * what every check uses; this only decides what a row says. The assurance level
 * travels with it so a list cannot show an unverified name as though it were
 * settled - see the identity badge.
 */
export interface Person {
  did: string
  label: string
  assurance: IdentityAssurance
}

const STRENGTH: Record<Ability, number> = { read: 1, write: 2, admin: 3 }

export function abilityStrength(ability: Ability): number {
  return STRENGTH[ability]
}

/** A verified grant, with the chain that proved it. */
export interface AccessGrant {
  capability: Capability
  /** Root-first, as `verifyChain` returns it. */
  chain: Capability[]
  /** True when the grant names this exact resource rather than an ancestor. */
  direct: boolean
}

export interface AccessEntry {
  /** `did:key`. Opaque - a device today, possibly a group later. */
  principal: string
  /** Strongest ability any verified grant confers here. */
  ability: Ability
  /** The grant conferring `ability`. Changing access means changing this one. */
  via: AccessGrant
  /** Every verified grant covering this resource, strongest first. */
  grants: AccessGrant[]
  /** The ancestor resource access flows from, or null when it is direct. */
  inheritedFrom: string | null
  /** Onward re-delegations left on `via`. Zero means they cannot re-share. */
  depth: number
  /** When `via` lapses. */
  expiresAt: number
}

/** Strongest first, then the one a person can actually act on. */
function compareGrants(a: AccessGrant, b: AccessGrant): number {
  const byAbility = STRENGTH[b.capability.payload.can] - STRENGTH[a.capability.payload.can]
  if (byAbility !== 0) return byAbility
  // A direct grant is the one that can be changed here. Preferring it when the
  // ability is equal keeps the row from pointing at a notebook grant, where
  // removal would do far more than was asked.
  if (a.direct !== b.direct) return a.direct ? -1 : 1
  return b.capability.payload.exp - a.capability.payload.exp
}

/**
 * Who has access, and by what route. A grant on `notebook:1` covers
 * `notebook:1/note:abc`, so a note list built from note-level grants alone
 * would omit most of the people who can read it.
 */
export async function summarizeAccess(
  capabilities: Iterable<Capability>,
  resource: string,
  context: AuthorizationContext,
): Promise<AccessEntry[]> {
  const byPrincipal = new Map<string, AccessGrant[]>()

  for (const capability of capabilities) {
    if (!resourceContains(capability.payload.rsc, resource)) continue
    const result = await verifyChain(capability, context)
    if (!result.authorized) continue

    const grant: AccessGrant = {
      capability,
      chain: result.chain ?? [capability],
      direct: capability.payload.rsc === resource,
    }
    const existing = byPrincipal.get(capability.payload.aud)
    if (existing) existing.push(grant)
    else byPrincipal.set(capability.payload.aud, [grant])
  }

  const entries: AccessEntry[] = []
  for (const [principal, grants] of byPrincipal) {
    grants.sort(compareGrants)
    const via = grants[0]
    entries.push({
      principal,
      ability: via.capability.payload.can,
      via,
      grants,
      inheritedFrom: via.direct ? null : via.capability.payload.rsc,
      depth: via.capability.payload.dep,
      expiresAt: via.capability.payload.exp,
    })
  }

  entries.sort((a, b) => {
    const byAbility = STRENGTH[b.ability] - STRENGTH[a.ability]
    return byAbility !== 0 ? byAbility : a.principal.localeCompare(b.principal)
  })
  return entries
}

/**
 * The same rule `verifyRevocation` enforces: the owner, or an issuer on the
 * chain. The button has to agree, or it fails after being pressed.
 */
export function canRevoke(grant: AccessGrant, actor: string, owner: string): boolean {
  return actor === owner || grant.chain.some((link) => link.payload.iss === actor)
}

export interface RemovalPlan {
  /** Grants that must be withdrawn, and that this actor may withdraw. */
  revoke: Capability[]
  /** Grants this actor cannot withdraw. Access survives while any of these do. */
  blocked: Capability[]
  /** Grants reaching past this resource, whose removal goes further than asked. */
  wider: Capability[]
  /** True when withdrawing everything possible still leaves access in place. */
  partial: boolean
}

/**
 * What removal entails. Two things a plain button gets wrong: a person may hold
 * several grants, and the one conferring access here may name an ancestor.
 */
export function removalPlan(entry: AccessEntry, resource: string, actor: string, owner: string): RemovalPlan {
  const revoke: Capability[] = []
  const blocked: Capability[] = []
  const wider: Capability[] = []

  for (const grant of entry.grants) {
    if (canRevoke(grant, actor, owner)) revoke.push(grant.capability)
    else blocked.push(grant.capability)
    if (grant.capability.payload.rsc !== resource) wider.push(grant.capability)
  }

  return { revoke, blocked, wider, partial: blocked.length > 0 }
}

/** What a new grant rests on, and how far it may go. */
export interface GrantBudget {
  /** Strongest ability the actor may confer. Null when they may not share at all. */
  maxAbility: Ability | null
  /** The proof a new grant points at. Null when the actor is the owner. */
  proof: Capability | null
  /** Onward re-delegations the actor may pass on. Zero means recipients cannot re-share. */
  maxDepth: number
  notBefore: number
  /** A grant may not outlive its proof, so this is a hard ceiling on expiry. */
  notAfter: number
  /** Why sharing is unavailable or capped. */
  reason?: string
}

const DEFAULT_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Derived from the attenuation rules rather than a role, because those are what
 * the verifier applies. Offering more would teach people the levels are advisory.
 */
export async function grantBudget(
  actor: string,
  resource: string,
  context: AuthorizationContext,
  horizonMs: number = DEFAULT_HORIZON_MS,
): Promise<GrantBudget> {
  if (actor === context.owner) {
    return {
      maxAbility: "admin",
      proof: null,
      maxDepth: MAX_CHAIN_DEPTH - 1,
      notBefore: context.now,
      notAfter: context.now + horizonMs,
    }
  }

  let best: Capability | null = null
  let held: Ability | null = null

  for (const capability of context.proofs.values()) {
    if (capability.payload.aud !== actor) continue
    if (!resourceContains(capability.payload.rsc, resource)) continue
    if (!(await verifyChain(capability, context)).authorized) continue

    held = held === null || STRENGTH[capability.payload.can] > STRENGTH[held] ? capability.payload.can : held
    // A non-delegable leaf is a deliberate shape, reported as such.
    if (capability.payload.dep < 1) continue
    if (best === null) best = capability
    else {
      const stronger = STRENGTH[capability.payload.can] - STRENGTH[best.payload.can]
      if (stronger > 0 || (stronger === 0 && capability.payload.dep > best.payload.dep)) best = capability
    }
  }

  if (!best) {
    return {
      maxAbility: null,
      proof: null,
      maxDepth: 0,
      notBefore: context.now,
      notAfter: context.now,
      reason:
        held === null
          ? "You do not have access to this yourself, so there is nothing to share."
          : "Your own access was granted without the right to pass it on.",
    }
  }

  return {
    maxAbility: best.payload.can,
    proof: best,
    maxDepth: best.payload.dep - 1,
    notBefore: Math.max(context.now, best.payload.nbf),
    notAfter: best.payload.exp,
    ...(best.payload.can === "admin"
      ? {}
      : { reason: `You can share at most your own level, ${best.payload.can}.` }),
  }
}

export interface GrantRequest {
  audience: string
  resource: string
  ability: Ability
  /** Zero unless re-sharing was enabled. */
  depth: number
  expiresAt: number
  /** Passed through so the caller signs the right chain. */
  proof: Capability | null
}
