/**
 * A re-delegation may only narrow. Without these, a holder could hand on more
 * than they were given and walking to the owner would prove nothing.
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
 * Exact match or a descendant under `/`. The separator is what stops
 * `notebook:1` from containing `notebook:10`.
 */
export function resourceContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export interface AttenuationFailure {
  rule: "ability" | "resource" | "depth" | "validity" | "linkage"
  detail: string
}

/**
 * `linkage` is the easy one to forget: the child's issuer must be the parent's
 * audience, or anyone could staple their token to someone else's proof.
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
  // A parent with dep 0 is a leaf and may delegate nothing.
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
