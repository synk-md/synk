/**
 * What each level actually lets someone do, in words.
 *
 * Separated from the components so both the picker and the access list say the
 * same thing. A level that means one thing while granting and something vaguer
 * while reviewing is how people end up surprised by who can do what.
 *
 * The consequence lines are deliberately about capability, not about intent:
 * "can share it with anyone else" rather than "for trusted collaborators".
 */

import type { Ability } from "@/lib/authz"

export interface AbilityCopy {
  /** What the level is called. */
  label: string
  /** The one line under it. Says what the holder gains over the level below. */
  consequence: string
  /** Shorter form, for a row in a list. */
  short: string
}

export const ABILITY_COPY: Record<Ability, AbilityCopy> = {
  read: {
    label: "Can read",
    consequence: "Open it and read everything in it. Cannot change anything.",
    short: "Read",
  },
  write: {
    label: "Can edit",
    consequence: "Everything above, plus write, rename and delete.",
    short: "Edit",
  },
  admin: {
    label: "Can manage access",
    consequence:
      "Everything above, plus share it with other people at any level up to their own.",
    short: "Manage access",
  },
}

/**
 * The part of admin people are surprised by, stated at the point of granting.
 *
 * Both halves matter. Access can spread without passing through you, and the
 * reason that is survivable is that withdrawing their grant collapses
 * everything underneath it - a chain is only valid while every link is.
 */
export const ADMIN_WARNING =
  "They will be able to share this with people you have not met. You can still remove them, which removes everyone they shared with too."

/**
 * Said wherever a grant is withdrawn.
 *
 * Revocation propagates like any other record, so there is a window in which a
 * peer has not seen it. And a reader who has already decrypted content has it;
 * key rotation governs what comes next, not what went before. Neither is a
 * defect to hide - somebody deciding whether removal is enough needs to know.
 */
export const REMOVAL_REALITY =
  "They lose access as this reaches each device. Anything they have already read, they keep."

/** Shown when re-sharing is offered. Off by default, so this explains turning it on. */
export const REDELEGATION_NOTE =
  "Off by default. When off, they can use this access but cannot pass it on to anyone."
