"use client"

import * as React from "react"
import { RiLockLine } from "@remixicon/react"

import { ABILITY_COPY } from "./ability-copy"
import { ABILITIES, abilityStrength } from "./access-model"
import type { Ability } from "@/lib/authz"

import "./sharing.scss"

export type AccessLevelPickerProps = {
  value: Ability
  onChange: (ability: Ability) => void
  /** Strongest level on offer. Anything above renders locked, with the reason. */
  max?: Ability
  /** Why the stronger levels are unavailable. Shown once, beside the first one. */
  ceilingReason?: string
  /** Distinguishes several pickers on one screen. */
  name?: string
  disabled?: boolean
  className?: string
}

/**
 * Choosing a level, with every level's consequence visible at once.
 *
 * A dropdown would be more compact and is the wrong control here. It shows the
 * chosen option and hides what the others would have meant, so the comparison
 * that would stop someone granting admin when they meant edit never happens.
 * Radios put all three consequences on screen at the moment of choosing.
 *
 * Levels above what the person may grant are rendered locked rather than
 * omitted. Omitting them makes a capped picker look like the whole truth;
 * showing them locked says there is more, and that this person cannot give it.
 */
export function AccessLevelPicker({
  value,
  onChange,
  max = "admin",
  ceilingReason,
  name = "access-level",
  disabled,
  className,
}: AccessLevelPickerProps) {
  const ceiling = abilityStrength(max)
  const firstLockedIndex = ABILITIES.findIndex((ability) => abilityStrength(ability) > ceiling)

  return (
    <div className={["shr-levels", className ?? ""].join(" ")} role="radiogroup" aria-label="Access level">
      {ABILITIES.map((ability, index) => {
        const locked = abilityStrength(ability) > ceiling
        const copy = ABILITY_COPY[ability]
        const id = `${name}-${ability}`

        return (
          <React.Fragment key={ability}>
            <label
              htmlFor={id}
              className={[
                "shr-level",
                value === ability && !locked ? "is-selected" : "",
                locked ? "is-locked" : "",
              ].join(" ")}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={ability}
                checked={value === ability && !locked}
                disabled={locked || disabled}
                // Checked here as well as on the input. `disabled` is a
                // rendering concern; this is the one that decides, and the
                // level being capped is the level someone should not get.
                onChange={() => {
                  if (!locked) onChange(ability)
                }}
              />
              <span className="shr-level-body">
                <span className="shr-level-label">
                  {copy.label}
                  {locked && (
                    <span className="shr-level-lock" aria-hidden="true">
                      <RiLockLine />
                    </span>
                  )}
                </span>
                <span className="shr-level-consequence">{copy.consequence}</span>
              </span>
            </label>
            {locked && index === firstLockedIndex && ceilingReason && (
              <p className="shr-ceiling" role="note">
                {ceilingReason}
              </p>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default AccessLevelPicker
