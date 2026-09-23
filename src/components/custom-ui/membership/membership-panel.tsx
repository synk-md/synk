"use client"

import * as React from "react"

import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"
import type { User } from "@/lib/identity"
import type { FreshnessAssessment } from "@/lib/membership"

import { AdmitMemberDialog, type AdmissionRequest } from "./admit-member-dialog"
import type { ChangeLevelRequest } from "./change-level-control"
import type { LinkRevocationRequest } from "./device-revocation"
import { MemberList } from "./member-list"
import { memberViews, type MemberView, type PendingRemoval, type RemovalRequest } from "./membership-model"
import { RemoveMemberDialog } from "./remove-member-dialog"
import { RevocationStatus } from "./revocation-status"

import "./membership.scss"

export type MembershipPanelProps = {
  users: readonly User[]
  capabilities: readonly Capability[]
  resource: string
  resourceLabel: string
  context: AuthorizationContext
  actingDid: string
  assessment: FreshnessAssessment
  pending?: readonly PendingRemoval[]
  localRevokedIds?: readonly string[]
  onAdmit: (request: AdmissionRequest) => Promise<void> | void
  onRemove: (request: RemovalRequest, reason: string | undefined) => Promise<void> | void
  onChangeLevel: (request: ChangeLevelRequest) => Promise<void> | void
  onRevokeLink: (request: LinkRevocationRequest) => Promise<void> | void
  maxAbility?: Ability
  now?: number
  className?: string
}

/**
 * Membership for one resource. The removal status sits above the list, not in
 * the row that prompted it: it explains why a name is still there at all.
 */
export function MembershipPanel({
  users,
  capabilities,
  resource,
  resourceLabel,
  context,
  actingDid,
  assessment,
  pending = [],
  localRevokedIds = [],
  onAdmit,
  onRemove,
  onChangeLevel,
  onRevokeLink,
  maxAbility = "admin",
  now = Date.now(),
  className,
}: MembershipPanelProps) {
  const [members, setMembers] = React.useState<MemberView[]>([])
  const [loading, setLoading] = React.useState(true)
  const [admitting, setAdmitting] = React.useState<MemberView | null>(null)
  const [removing, setRemoving] = React.useState<MemberView | null>(null)

  const latest = React.useRef({ users, capabilities, context })
  latest.current = { users, capabilities, context }

  // A fresh context object per render must not restart the walk.
  const key = [
    resource,
    context.owner,
    String(context.now),
    users.map((user) => user.userId).join(","),
    capabilities.map((capability) => capability.cid).sort().join(","),
    [...(context.revoked ?? [])].sort().join(","),
  ].join("|")

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    const { users: u, capabilities: c, context: ctx } = latest.current
    void memberViews(u, c, resource, ctx).then((views) => {
      if (!cancelled) {
        setMembers(views)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Derived from the same verified view the list is drawn from, so the reseal
  // set cannot drift from what is shown.
  const remaining = React.useMemo(
    () =>
      members
        .filter((member) => member.ability !== null && member.member !== removing?.member)
        .flatMap((member) => member.principals.map((did) => ({ did, label: member.label }))),
    [members, removing],
  )

  return (
    <div className={["mb-panel", className ?? ""].join(" ")}>
      <RevocationStatus
        assessment={assessment}
        pending={pending}
        localRevokedIds={localRevokedIds}
        now={now}
      />

      {loading ? (
        <p className="mb-empty" role="status">
          Checking who is in this workspace…
        </p>
      ) : (
        <MemberList
          members={members}
          resourceLabel={resourceLabel}
          actingDid={actingDid}
          pending={pending}
          maxAbility={maxAbility}
          onAdmit={setAdmitting}
          onRemove={setRemoving}
          onChangeLevel={onChangeLevel}
          onRevokeLink={onRevokeLink}
        />
      )}

      <AdmitMemberDialog
        open={admitting !== null}
        onClose={() => setAdmitting(null)}
        member={admitting}
        resourceLabel={resourceLabel}
        maxAbility={maxAbility}
        onAdmit={onAdmit}
        now={now}
      />

      <RemoveMemberDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        member={removing}
        remaining={remaining}
        onRemove={onRemove}
      />
    </div>
  )
}

export default MembershipPanel
