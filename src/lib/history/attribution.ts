/**
 * Resolving a restore point's `did:key` to a stable identity.
 *
 * The key is the anchor: a snapshot names the device that produced it, and
 * everything else - member, label, assurance - is looked up from the directory
 * and may change or disagree. So a byline is a *view* of a key, never the other
 * way round.
 *
 * Nothing here throws. This runs on a render path, and one member with
 * conflicting admin-attested labels must not take down a whole timeline.
 */

import type { IdentityAssurance } from "@/components/custom-ui/identity/identity-badge"
import { findUserByDeviceDid, memberOf, userLabel, type User } from "@/lib/identity"

export interface TimelineAttribution {
  /** `did:key` of the producing device. The anchor, always present. */
  author: string
  /** Member id, when the directory knows this key. */
  member: string | null
  /** What to show. Never blank - falls back to the key itself. */
  label: string
  assurance: IdentityAssurance
  /** Set when admins attested different names. Shown, never resolved here. */
  conflict: readonly string[] | null
  /** The directory has no record of this key at all. */
  unknown: boolean
}

/** Enough of a key to be recognisable without being mistaken for a name. */
function shortKey(did: string): string {
  const tail = did.slice(-8)
  return `Unknown device ${tail}`
}

export function resolveAttribution(did: string, users: readonly User[]): TimelineAttribution {
  const user = findUserByDeviceDid(users, did)
  if (!user) {
    return {
      author: did,
      member: null,
      label: shortKey(did),
      assurance: "self-asserted",
      conflict: null,
      unknown: true,
    }
  }

  const device = user.devices.find((candidate) => candidate.record.did === did)
  const member = device ? memberOf(device) : user.userId
  const resolved = userLabel(user)

  // `userLabel` returns a value rather than throwing precisely so this path
  // can render a conflict instead of failing.
  if (resolved.status === "conflicted") {
    return {
      author: did,
      member,
      label: resolved.labels.join(" / "),
      assurance: "self-asserted",
      conflict: resolved.labels,
      unknown: false,
    }
  }

  if (resolved.status === "none") {
    // Known key, no admin-attested name - a self-linked device whose member has
    // no admission on record here.
    return {
      author: did,
      member,
      label: member,
      assurance: "self-asserted",
      conflict: null,
      unknown: false,
    }
  }

  return {
    author: did,
    member,
    label: resolved.label,
    assurance: "invited",
    conflict: null,
    unknown: false,
  }
}

/** Resolve many at once, deduplicated by key. */
export function resolveAll(
  dids: readonly string[],
  users: readonly User[],
): Map<string, TimelineAttribution> {
  const out = new Map<string, TimelineAttribution>()
  for (const did of dids) {
    if (!out.has(did)) out.set(did, resolveAttribution(did, users))
  }
  return out
}
