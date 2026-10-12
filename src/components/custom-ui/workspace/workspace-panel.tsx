"use client"

import { RiAlertLine, RiGroupLine, RiQuestionLine, RiShieldCheckLine } from "@remixicon/react"

import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { useFingerprints } from "@/hooks/use-device-identity"
import { userLabel, type User } from "@/lib/identity"
import type { NotebookWorkspace } from "@/lib/workspace"

import "./workspace.scss"

export type WorkspacePanelProps = {
  workspace: NotebookWorkspace | null
  loading?: boolean
  /** This device, so its own row can be marked. */
  selfDid?: string
  /** Offered on every row but the owner's. Only passed to the owner. */
  onRemove?: (user: User) => void
  className?: string
}

/** Never throws on a conflict; a disputed byline is shown, not resolved. */
function labelOf(user: User): { text: string; conflict: readonly string[] | null } {
  const resolved = userLabel(user)
  if (resolved.status === "attested") return { text: resolved.label, conflict: null }
  if (resolved.status === "conflicted") {
    return { text: resolved.labels.join(" / "), conflict: resolved.labels }
  }
  return { text: user.userId, conflict: null }
}

/**
 * Who this notebook belongs to and who is in it.
 *
 * Ownership comes first because nothing below it means anything without it: the
 * member list is read against the owner as the only trusted admin, so an
 * unowned or disputed notebook has no member list at all rather than an
 * unverified one.
 */
export function WorkspacePanel({
  workspace,
  loading,
  selfDid,
  onRemove,
  className,
}: WorkspacePanelProps) {
  const dids = workspace?.directory?.devices.map((device) => device.record.did) ?? []
  const fingerprints = useFingerprints(dids)

  if (loading || !workspace) {
    return (
      <p className="ws-empty" role="status">
        Checking who this notebook belongs to…
      </p>
    )
  }

  const { ownership } = workspace

  if (ownership.status === "disputed") {
    return (
      <div className="ws-warning is-critical" role="alert">
        <span className="ws-warning-icon" aria-hidden="true">
          <RiAlertLine />
        </span>
        <div>
          <strong>Two devices both claim to own this notebook.</strong>
          <p>
            {ownership.claims.length} signed claims are present and there is no way to tell which
            came first. Nobody is treated as an admin until this is settled, so the member list is
            hidden rather than shown unverified.
          </p>
        </div>
      </div>
    )
  }

  if (ownership.status === "none") {
    return (
      <div className="ws-warning" role="note">
        <span className="ws-warning-icon" aria-hidden="true">
          <RiQuestionLine />
        </span>
        <div>
          <strong>This notebook has no recorded owner.</strong>
          <p>
            It was created before notebooks kept one. Everything still works; there is just no
            admin, so nobody can be admitted to it yet.
          </p>
        </div>
      </div>
    )
  }

  const ownerUser = workspace.users.find((user) =>
    user.devices.some((device) => device.record.did === ownership.owner),
  )

  return (
    <div className={["ws-panel", className ?? ""].join(" ")}>
      <p className="ws-owner">
        <RiShieldCheckLine aria-hidden="true" />
        Owned by <strong>{ownerUser ? labelOf(ownerUser).text : "an unknown device"}</strong>
      </p>

      <h4 className="ws-heading">
        <RiGroupLine aria-hidden="true" />
        {workspace.users.length === 1 ? "1 member" : `${String(workspace.users.length)} members`}
      </h4>

      <ul className="ws-list" aria-label="Members">
        {workspace.users.map((user) => {
          const label = labelOf(user)
          const isSelf = user.devices.some((device) => device.record.did === selfDid)

          return (
            <li key={user.userId} className="ws-member">
              <span className="ws-member-main">
                <span className="ws-member-name">
                  {label.text}
                  <IdentityBadge assurance={label.conflict ? "self-asserted" : "invited"} />
                  {isSelf && <span className="ws-chip">This device</span>}
                </span>
                <span className="ws-member-meta">
                  {user.devices.length === 1
                    ? "1 device"
                    : `${String(user.devices.length)} devices`}
                  {" · "}
                  <code className="ws-fingerprint">
                    {fingerprints[user.devices[0]?.record.did ?? ""] ?? "…"}
                  </code>
                </span>
                {label.conflict && (
                  <span className="ws-note is-loud">
                    Recorded under different names: {label.conflict.join(", ")}.
                  </span>
                )}
              </span>
              {onRemove && !user.devices.some((device) => device.record.did === ownership.owner) && (
                <Button
                  type="button"
                  data-style="ghost"
                  className="ws-remove"
                  aria-label={`Remove ${label.text}`}
                  onClick={() => onRemove(user)}
                >
                  <span className="tiptap-button-text">Remove</span>
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      {workspace.directory && workspace.directory.rejected > 0 && (
        <p className="ws-note">
          {workspace.directory.rejected} record
          {workspace.directory.rejected === 1 ? " was" : "s were"} dropped for failing
          verification.
        </p>
      )}
    </div>
  )
}

export default WorkspacePanel
