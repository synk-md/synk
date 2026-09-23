"use client"

import * as React from "react"
import { RiUserUnfollowLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { AccessLevelPicker } from "@/components/custom-ui/sharing/access-level-picker"
import type { Ability } from "@/lib/authz"

import type { MemberView } from "./membership-model"

import "./membership.scss"

export type ChangeLevelRequest = {
  member: MemberView
  ability: Ability
  /** Withdrawn first. Derived, so none is left behind. */
  held: readonly { cid: string }[]
}

export type ChangeLevelControlProps = {
  member: MemberView
  onSave: (request: ChangeLevelRequest) => Promise<void> | void
  onCancel: () => void
  /** The removal path, which is what "no access" actually is. */
  onRemoveInstead?: (member: MemberView) => void
  maxAbility?: Ability
  className?: string
}

/**
 * No "no access" level, deliberately: that is removal, which rotates. A fourth
 * level would leave a member with no capability still holding the current key.
 *
 * Nothing rotates here in either direction, since every level implies read -
 * worth saying, so nobody thinks a downgrade did more than it did.
 */
export function ChangeLevelControl({
  member,
  onSave,
  onCancel,
  onRemoveInstead,
  maxAbility = "admin",
  className,
}: ChangeLevelControlProps) {
  const [ability, setAbility] = React.useState<Ability>(member.ability ?? "read")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave({ member, ability, held: member.held })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the level.")
    } finally {
      setBusy(false)
    }
  }

  const downgrade = member.ability !== null && ability !== member.ability

  return (
    <div className={["mb-inline-editor", className ?? ""].join(" ")}>
      <AccessLevelPicker
        value={ability}
        onChange={setAbility}
        max={maxAbility}
        name={`member-level-${member.member}`}
        disabled={busy}
      />

      <p className="mb-note">
        The old grant is withdrawn first, then the new one is issued, so there is never a moment
        where both apply.
        {downgrade &&
          " They can still read either way — every level includes reading, so this does not change what they can see."}
      </p>

      {member.held.length > 1 && (
        <p className="mb-note">
          {member.held.length} grants are withdrawn — one for each of their keys.
        </p>
      )}

      {onRemoveInstead && (
        <button type="button" className="mb-inline-link" onClick={() => onRemoveInstead(member)}>
          <RiUserUnfollowLine aria-hidden="true" />
          Take away access entirely instead
        </button>
      )}

      {error && (
        <span className="mb-error" role="alert">
          {error}
        </span>
      )}

      <div className="mb-inline-actions">
        <Button data-style="ghost" onClick={onCancel}>
          <span className="tiptap-button-text">Cancel</span>
        </Button>
        <Button
          className="mb-primary-btn is-active"
          disabled={busy || ability === member.ability}
          onClick={() => void save()}
        >
          <span className="tiptap-button-text">{busy ? "Saving…" : "Save level"}</span>
        </Button>
      </div>
    </div>
  )
}

export default ChangeLevelControl
