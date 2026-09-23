"use client"

import * as React from "react"
import { RiGroupLine, RiUserAddLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { ABILITY_COPY } from "@/components/custom-ui/sharing/ability-copy"
import type { Ability } from "@/lib/authz"

import { ChangeLevelControl, type ChangeLevelRequest } from "./change-level-control"
import { DeviceRevocation, type LinkRevocationRequest } from "./device-revocation"
import type { MemberView, PendingRemoval } from "./membership-model"

import "./membership.scss"

export type MemberListProps = {
  members: readonly MemberView[]
  /** Reads in a sentence: "this notebook". */
  resourceLabel: string
  actingDid: string
  /** So a lingering row is explained in place. */
  pending?: readonly PendingRemoval[]
  onAdmit?: (member: MemberView) => void
  onRemove?: (member: MemberView) => void
  onChangeLevel?: (request: ChangeLevelRequest) => Promise<void> | void
  onRevokeLink?: (request: LinkRevocationRequest) => Promise<void> | void
  maxAbility?: Ability
  className?: string
}

/**
 * Everyone in the workspace and what they hold here. People with no access are
 * listed too, with the way in beside them - that is where admission starts.
 *
 * A member whose removal is still propagating keeps their row, labelled.
 * Vanishing on click would be more satisfying and untrue.
 */
export function MemberList({
  members,
  resourceLabel,
  actingDid,
  pending = [],
  onAdmit,
  onRemove,
  onChangeLevel,
  onRevokeLink,
  maxAbility = "admin",
  className,
}: MemberListProps) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const removing = new Set(pending.map((entry) => entry.label))

  if (members.length === 0) {
    return (
      <p className="mb-empty" role="status">
        Nobody is in this workspace yet.
      </p>
    )
  }

  return (
    <ul className={["mb-member-list", className ?? ""].join(" ")} aria-label="Members">
      {members.map((member) => {
        const hasAccess = member.ability !== null
        const isRemoving = removing.has(member.label)
        const deviceCount = member.devices.length

        return (
          <li
            key={member.member}
            className={[
              "mb-member",
              hasAccess ? "" : "is-outside",
              isRemoving ? "is-removing" : "",
            ].join(" ")}
          >
            <span className="mb-member-icon" aria-hidden="true">
              <RiGroupLine />
            </span>

            <span className="mb-member-main">
              <span className="mb-member-name">
                {member.label}
                <IdentityBadge assurance={member.assurance} />
                {isRemoving && <span className="mb-chip is-removing">Removing…</span>}
              </span>

              <span className="mb-member-meta">
                {hasAccess ? (
                  <>
                    {member.principals.length === 1
                      ? "1 key"
                      : `${String(member.principals.length)} keys`}{" "}
                    with access to {resourceLabel}
                  </>
                ) : (
                  <>In the workspace, but no access to {resourceLabel}</>
                )}
                {" · "}
                <button
                  type="button"
                  className="mb-inline-link"
                  onClick={() => setExpanded(expanded === member.member ? null : member.member)}
                >
                  {deviceCount === 1 ? "1 device" : `${String(deviceCount)} devices`}
                </button>
              </span>

              {member.labelConflict && (
                <span className="mb-note is-loud">
                  Two admins attested different names for this member:{" "}
                  {member.labelConflict.join(", ")}.
                </span>
              )}

              {expanded === member.member && onRevokeLink && (
                <DeviceRevocation
                  devices={member.devices}
                  actingDid={actingDid}
                  member={member.member}
                  onRevokeLink={onRevokeLink}
                />
              )}

              {editing === member.member && onChangeLevel && (
                <ChangeLevelControl
                  member={member}
                  maxAbility={maxAbility}
                  onSave={async (request) => {
                    await onChangeLevel(request)
                    setEditing(null)
                  }}
                  onCancel={() => setEditing(null)}
                  {...(onRemove
                    ? {
                        onRemoveInstead: (target: MemberView) => {
                          setEditing(null)
                          onRemove(target)
                        },
                      }
                    : {})}
                />
              )}
            </span>

            <span className={["mb-pill", member.ability ? `is-${member.ability}` : "is-none"].join(" ")}>
              {member.ability ? ABILITY_COPY[member.ability].short : "No access"}
            </span>

            {editing !== member.member && (
              <span className="mb-member-actions">
                {!hasAccess && onAdmit && (
                  <Button
                    className="mb-primary-btn is-active"
                    aria-label={`Give ${member.label} access`}
                    onClick={() => onAdmit(member)}
                  >
                    <RiUserAddLine className="tiptap-button-icon" />
                    <span className="tiptap-button-text">Give access</span>
                  </Button>
                )}
                {hasAccess && onChangeLevel && (
                  <Button
                    data-style="ghost"
                    disabled={isRemoving}
                    aria-label={`Change level for ${member.label}`}
                    onClick={() => setEditing(member.member)}
                  >
                    <span className="tiptap-button-text">Change</span>
                  </Button>
                )}
                {hasAccess && onRemove && (
                  <Button
                    data-style="ghost"
                    disabled={isRemoving}
                    aria-label={`Remove ${member.label}`}
                    onClick={() => onRemove(member)}
                  >
                    <span className="tiptap-button-text">Remove</span>
                  </Button>
                )}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default MemberList
