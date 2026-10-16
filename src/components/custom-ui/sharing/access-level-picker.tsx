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
  /** Strongest on offer. Above this renders locked. */
  max?: Ability
  /** Shown once, beside the first locked level. */
  ceilingReason?: string
  /** Weakest on offer: below this means nothing here. Renders locked too. */
  min?: Ability
  /** Shown once, beside the levels below `min`. */
  floorReason?: string
  /** Distinguishes several pickers on one screen. */
  name?: string
  disabled?: boolean
  className?: string
}

/**
 * Radios, not a dropdown: a dropdown hides what the other levels would have
 * meant, so the comparison that stops an accidental admin grant never happens.
 *
 * Levels above the ceiling render locked rather than omitted, or a capped
 * picker would look like the whole truth.
 */
export function AccessLevelPicker({
  value,
  onChange,
  max = "admin",
  ceilingReason,
  min = "read",
  floorReason,
  name = "access-level",
  disabled,
  className,
}: AccessLevelPickerProps) {
  const ceiling = abilityStrength(max)
  const floor = abilityStrength(min)
  const firstLockedIndex = ABILITIES.findIndex((ability) => abilityStrength(ability) > ceiling)
  const lastFloorIndex = ABILITIES.filter((ability) => abilityStrength(ability) < floor).length - 1

  return (
    <div className={["shr-levels", className ?? ""].join(" ")} role="radiogroup" aria-label="Access level">
      {ABILITIES.map((ability, index) => {
        const locked = abilityStrength(ability) > ceiling || abilityStrength(ability) < floor
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
                // `disabled` is a rendering concern; this is what decides.
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
            {index === lastFloorIndex && floorReason && (
              <p className="shr-ceiling" role="note">
                {floorReason}
              </p>
            )}
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
