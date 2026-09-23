/**
 * What each level lets someone do, shared so the picker and the access list say
 * the same thing. Worded as capability, never intent.
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

/** Access can spread out of view; revoking a parent collapses the subtree. */
export const ADMIN_WARNING =
  "They will be able to share this with people you have not met. You can still remove them, which removes everyone they shared with too."

/** Said wherever a grant is withdrawn. Neither half is a defect to hide. */
export const REMOVAL_REALITY =
  "They lose access as this reaches each device. Anything they have already read, they keep."

/** Shown when re-sharing is offered. */
export const REDELEGATION_NOTE =
  "Off by default. When off, they can use this access but cannot pass it on to anyone."
