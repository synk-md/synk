/**
 * Turning users, capabilities and freshness into the picture a person is shown.
 *
 * Kept out of React for the same reason the sharing model is: this decides who
 * appears to have access and what a removal is claimed to have done, and both
 * have to be derived rather than asserted.
 */

import type { IdentityAssurance } from "@/components/custom-ui/identity/identity-badge"
import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"
import { findUserByDeviceDid, memberOf, userLabel, type MemberDevice, type User } from "@/lib/identity"
import type { FreshnessAssessment } from "@/lib/membership"
import { summarizeAccess } from "@/components/custom-ui/sharing/access-model"

/**
 * A person, their keys, and what those keys can do here.
 *
 * `principals` is plural on purpose. Capabilities address device keys, never
 * people, so "Ada has edit" is really "each of Ada's three device keys holds a
 * capability". Any operation on a member has to reach all of them, and a model
 * that collapsed them to one would silently leave keys behind.
 */
export interface MemberView {
  /** Member id from the admission, e.g. `member:ada`. */
  member: string
  /** Admin-attested label, or the member id when no admission attests one. */
  label: string
  /** Never `verified` on the strength of an admission alone. */
  assurance: IdentityAssurance
  /** Conflicting admin-attested labels, surfaced rather than resolved. */
  labelConflict: readonly string[] | null
  devices: readonly MemberDevice[]
  /** Device DIDs holding a verified capability here. */
  principals: string[]
  /** Strongest ability any of their keys holds, or null for no access here. */
  ability: Ability | null
  /** Every verified capability across all their keys, for revoke and re-issue. */
  held: Capability[]
}

function labelOf(user: User): { label: string; conflict: readonly string[] | null } {
  const resolved = userLabel(user)
  if (resolved.status === "attested") return { label: resolved.label, conflict: null }
  if (resolved.status === "conflicted") {
    // Never pick a winner. A conflict means two admins attested different
    // names, and the interface should say so rather than choose.
    return { label: resolved.labels.join(" / "), conflict: resolved.labels }
  }
  return { label: user.userId, conflict: null }
}

const STRENGTH: Record<Ability, number> = { read: 1, write: 2, admin: 3 }

/**
 * Everyone in the workspace, and what they hold on this resource.
 *
 * Members with no capability here are included rather than filtered out. "In
 * the workspace, no access to this notebook" is a real and common state, and it
 * is the state from which someone is admitted - hiding it would hide the
 * entry point.
 */
export async function memberViews(
  users: readonly User[],
  capabilities: readonly Capability[],
  resource: string,
  context: AuthorizationContext,
): Promise<MemberView[]> {
  const entries = await summarizeAccess(capabilities, resource, context)

  const views = new Map<string, MemberView>()
  for (const user of users) {
    const { label, conflict } = labelOf(user)
    const member = user.devices.length > 0 ? memberOf(user.devices[0]) : user.userId
    views.set(user.userId, {
      member,
      label,
      // An admission says an admin meant this name for this member. It is the
      // same assurance an invitation carries, and no stronger.
      assurance: user.devices.some((device) => device.kind === "admitted") ? "invited" : "self-asserted",
      labelConflict: conflict,
      devices: user.devices,
      principals: [],
      ability: null,
      held: [],
    })
  }

  for (const entry of entries) {
    const user = findUserByDeviceDid(users, entry.principal)
    if (!user) continue
    const view = views.get(user.userId)
    if (!view) continue

    view.principals.push(entry.principal)
    view.held.push(...entry.grants.map((grant) => grant.capability))
    if (view.ability === null || STRENGTH[entry.ability] > STRENGTH[view.ability]) {
      view.ability = entry.ability
    }
  }

  return [...views.values()].sort((a, b) => {
    const rank = (view: MemberView) => (view.ability ? STRENGTH[view.ability] : 0)
    return rank(b) - rank(a) || a.label.localeCompare(b.label)
  })
}

/**
 * Everything a removal has to reach.
 *
 * Derived rather than typed in. One forgotten device key is a member who was
 * removed from the list and still holds write.
 */
export interface RemovalRequest {
  member: MemberView
  /** One lifecycle call per key: `removeMember` withdraws for a single audience. */
  deviceDids: string[]
  held: Capability[]
}

export function removalRequest(member: MemberView): RemovalRequest {
  return { member, deviceDids: [...member.principals], held: [...member.held] }
}

/**
 * Whether the device in hand may invalidate a given linked device.
 *
 * Mirrors `verifyLinkRevocation` rather than approximating it: an
 * admin-admitted device of the same member, and never the linked device itself.
 * A control that offers what the verifier will refuse is worse than no control,
 * because it teaches people the rules are advisory.
 */
export function canRevokeLink(
  devices: readonly MemberDevice[],
  actingDid: string,
  member: string,
  targetDid: string,
): boolean {
  if (actingDid === targetDid) return false
  return devices.some(
    (device) =>
      device.kind === "admitted" &&
      device.record.did === actingDid &&
      device.admission.member === member,
  )
}

/* ---- the revocation-latency window --------------------------------------- */

export interface PendingRemoval {
  /** Who was removed. */
  label: string
  /** cids of the revocations issued. Used to tell "arrived" from "not yet". */
  revocationCids: readonly string[]
  removedAt: number
}

export type RemovalPhase = "settling" | "settled" | "unconfirmable"

export interface RemovalProgress {
  phase: RemovalPhase
  /**
   * Always true, from the instant of removal. The epoch rotated, so reads are
   * denied whether or not a single peer ever hears about the revocation.
   */
  readsBlocked: true
  /** True only when the relay's own summary is known to include the withdrawal. */
  writesBlockedEverywhere: boolean
  elapsedMs: number
  headline: string
  detail: string
  /** True when the delay has stopped being ordinary. */
  needsAttention: boolean
}

/** How long a removal may be in flight before the wait stops being routine. */
export const DEFAULT_SETTLE_WINDOW_MS = 5 * 60 * 1000

function minutes(ms: number): string {
  const value = Math.max(0, Math.round(ms / 60000))
  if (value < 1) return "less than a minute"
  return value === 1 ? "1 minute" : `${String(value)} minutes`
}

/**
 * Where a removal has got to, and whether that is worth worrying about.
 *
 * The whole reason this exists: a removed member lingers, and the lingering
 * looks identical whether the revocation is propagating normally or a relay is
 * withholding it. Those mean completely different things, and only the
 * freshness summary separates them - so the phase is derived from the summary,
 * never from elapsed time alone.
 *
 * "Confirmed" is a real check, not a timer. The summary carries a digest of the
 * relay's revocation set; if the local set matches that digest and contains
 * these withdrawals, then the relay's set contains them too.
 */
export function removalProgress(
  removal: PendingRemoval,
  assessment: FreshnessAssessment,
  localRevokedIds: readonly string[],
  now: number,
  settleWindowMs: number = DEFAULT_SETTLE_WINDOW_MS,
): RemovalProgress {
  const elapsedMs = Math.max(0, now - removal.removedAt)
  const local = new Set(localRevokedIds)
  const allLocal = removal.revocationCids.every((cid) => local.has(cid))
  const confirmed = assessment.state === "fresh" && !assessment.setMismatch && allLocal

  const base = { readsBlocked: true as const, elapsedMs }

  if (confirmed) {
    return {
      ...base,
      phase: "settled",
      writesBlockedEverywhere: true,
      needsAttention: false,
      headline: `${removal.label} has been removed.`,
      detail:
        "Their key access ended the moment you removed them, and the withdrawal has reached everyone.",
    }
  }

  // A digest mismatch is excluded from the reassuring path deliberately. The
  // settling message promises this takes seconds; a local set that disagrees
  // with the relay's is a concrete disagreement, not latency.
  if (assessment.state === "fresh" && !assessment.setMismatch && elapsedMs <= settleWindowMs) {
    return {
      ...base,
      phase: "settling",
      writesBlockedEverywhere: false,
      needsAttention: false,
      headline: `${removal.label} is being removed.`,
      detail:
        "They can no longer read anything new — that took effect immediately. Their edits stop being accepted on each device as it catches up, which usually takes seconds.",
    }
  }

  // Either the summary is not fresh, or it is fresh and still does not contain
  // the withdrawal well after it should. Both mean the same thing to a person:
  // this can no longer be confirmed, and that is different from being slow.
  const because =
    assessment.state === "regressed"
      ? "A device offered an older list of withdrawals than one already seen."
      : assessment.state === "missing"
        ? "No signed list of withdrawals has arrived yet."
        : assessment.setMismatch
          ? "Your list of withdrawals does not match the one the relay is publishing."
          : `The list of withdrawals has not advanced for ${minutes(assessment.ageMs ?? elapsedMs)}.`

  return {
    ...base,
    phase: "unconfirmable",
    writesBlockedEverywhere: false,
    needsAttention: true,
    headline: `Cannot confirm that ${removal.label}'s removal has reached everyone.`,
    detail: `${because} They still cannot read anything new — that does not depend on this. But their edits may still be accepted somewhere.`,
  }
}

export interface FreshnessCopy {
  tone: "ok" | "warn" | "alarm"
  headline: string
  detail: string
}

/**
 * The freshness state in plain words.
 *
 * `stale` is deliberately not alarming and `regressed` deliberately is. Being
 * behind is something an offline peer does legitimately; a sequence going
 * backwards is something only a misbehaving relay does.
 */
export function freshnessCopy(assessment: FreshnessAssessment): FreshnessCopy {
  switch (assessment.state) {
    case "fresh":
      return {
        tone: "ok",
        headline: "Withdrawals are up to date.",
        detail: `Last confirmed ${minutes(assessment.ageMs ?? 0)} ago.`,
      }
    case "stale":
      return {
        tone: "warn",
        headline: "Your list of withdrawals may be behind.",
        detail: assessment.setMismatch
          ? "It does not match what the relay is publishing. Removals you have made are still in force for reading; they may not be everywhere for writing."
          : `Nothing new has arrived for ${minutes(assessment.ageMs ?? 0)}. This is normal after being offline, and worth looking into otherwise.`,
      }
    case "regressed":
      return {
        tone: "alarm",
        headline: "A device sent an out-of-date list of withdrawals.",
        detail:
          "Lists only ever grow, so this should not happen. It was refused. Treat what this relay reports as unreliable until you know why.",
      }
    case "missing":
      return {
        tone: "warn",
        headline: "No confirmed list of withdrawals yet.",
        detail:
          "Until one arrives there is no way to tell whether a removal has reached other devices. Reading is unaffected — that never depended on it.",
      }
    case "unverified":
      return {
        tone: "alarm",
        headline: "The list of withdrawals could not be verified.",
        detail: "It was not signed by anyone this workspace trusts, so it was ignored.",
      }
  }
}
