/**
 * Attenuation: a re-delegation may only narrow.
 *
 * Every rule here is a "no wider than" check. Together they are what makes a
 * chain meaningful - without them a holder could hand on more than they were
 * given, and walking to the owner would prove nothing.
 */

import type { Ability, CapabilityPayload } from "./capability"

/** admin implies write implies read. */
const STRENGTH: Record<Ability, number> = { read: 1, write: 2, admin: 3 }

/** Does holding `held` satisfy a requirement for `needed`? */
export function abilitySatisfies(held: Ability, needed: Ability): boolean {
  return STRENGTH[held] >= STRENGTH[needed]
}

export function isWeakerOrEqual(child: Ability, parent: Ability): boolean {
  return STRENGTH[child] <= STRENGTH[parent]
}

/**
 * Resource containment. Exact match, or a descendant under `/`.
 *
 * `notebook:1` contains `notebook:1/note:abc` but not `notebook:10` - the
 * separator check is what stops a prefix from silently widening scope.
 */
export function resourceContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export interface AttenuationFailure {
  rule: "ability" | "resource" | "depth" | "validity" | "linkage"
  detail: string
}

/**
 * Check a child against the parent it claims to rest on.
 *
 * `linkage` is the one that is easy to forget: the child's issuer must be the
 * parent's audience, or anyone could staple their own token to someone else's
 * proof.
 */
export function checkAttenuation(
  child: CapabilityPayload,
  parent: CapabilityPayload,
): AttenuationFailure | null {
  if (child.iss !== parent.aud) {
    return {
      rule: "linkage",
      detail: `issuer ${child.iss} is not the audience of its proof (${parent.aud})`,
    }
  }
  if (!isWeakerOrEqual(child.can, parent.can)) {
    return { rule: "ability", detail: `cannot delegate ${child.can} from ${parent.can}` }
  }
  if (!resourceContains(parent.rsc, child.rsc)) {
    return { rule: "resource", detail: `${child.rsc} is not within ${parent.rsc}` }
  }
  // The parent's remaining budget must cover this delegation and what it grants
  // onward: a parent with dep 0 is a leaf and may delegate nothing at all.
  if (parent.dep < 1) {
    return { rule: "depth", detail: `proof is a non-delegable leaf (dep ${String(parent.dep)})` }
  }
  if (child.dep > parent.dep - 1) {
    return {
      rule: "depth",
      detail: `child depth ${String(child.dep)} exceeds the ${String(parent.dep - 1)} remaining`,
    }
  }
  if (child.nbf < parent.nbf || child.exp > parent.exp) {
    return { rule: "validity", detail: "child validity is not within its proof's" }
  }
  return null
}
