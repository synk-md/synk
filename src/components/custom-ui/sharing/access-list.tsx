"use client"

import * as React from "react"
import {
  RiAlertLine,
  RiFolderSharedLine,
  RiShareForwardLine,
  RiStarLine,
  RiUser3Line,
} from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { useAccessSummary, useGrantBudget } from "@/hooks/use-access"
import { useFingerprints } from "@/hooks/use-device-identity"
import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"

import { ABILITY_COPY, REMOVAL_REALITY } from "./ability-copy"
import { AccessLevelPicker } from "./access-level-picker"
import { abilityStrength, removalPlan, type AccessEntry, type Person, type RemovalPlan } from "./access-model"

import "./sharing.scss"

export type AccessListProps = {
  capabilities: readonly Capability[]
  /** Resource id, e.g. `notebook:1` or `notebook:1/note:abc`. */
  resource: string
  /** How the resource reads inside a sentence: "this note", "this notebook". */
  resourceLabel: string
  context: AuthorizationContext
  /** The principal acting. Controls appear only where they would succeed. */
  actor: string
  /** Names for the principals. Anyone missing shows as their fingerprint. */
  people?: readonly Person[]
  onRevoke?: (entry: AccessEntry, plan: RemovalPlan) => Promise<void> | void
  onChangeLevel?: (entry: AccessEntry, ability: Ability) => Promise<void> | void
  /** Strongest level on offer here, whatever the actor holds, and why. */
  ceiling?: Ability
  ceilingReason?: string
  /** Weakest level that means anything here, and why. */
  min?: Ability
  minReason?: string
  /** How a resource reads in a sentence, for access that comes from elsewhere. */
  nameOf?: (resource: string) => string
  className?: string
}

type RowMode = { kind: "idle" } | { kind: "removing" } | { kind: "level"; ability: Ability }

/**
 * Who has access, and by what route.
 *
 * The route is not a detail. A grant on a notebook covers every note in it, so
 * a note's list that showed only note-level grants would name a fraction of the
 * people who can read it and imply the rest could be removed here. Inherited
 * rows are therefore present, labelled with where they come from, and their
 * controls say what changing them would actually reach.
 *
 * Rows are ordered strongest first. The people who can do the most are the ones
 * worth noticing, and they are the ones a list sorted by name buries.
 */
export function AccessList({
  capabilities,
  resource,
  resourceLabel,
  context,
  actor,
  people,
  onRevoke,
  onChangeLevel,
  ceiling,
  ceilingReason,
  min,
  minReason,
  nameOf = (resource) => resource,
  className,
}: AccessListProps) {
  const { entries, loading } = useAccessSummary(capabilities, resource, context)
  const { budget } = useGrantBudget(actor, resource, context)
  const held = budget?.maxAbility ?? null
  const capped = held !== null && ceiling !== undefined && abilityStrength(ceiling) < abilityStrength(held)
  const [mode, setMode] = React.useState<Record<string, RowMode>>({})
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const dids = React.useMemo(() => entries.map((entry) => entry.principal), [entries])
  const fingerprints = useFingerprints(dids)
  const byDid = React.useMemo(
    () => new Map((people ?? []).map((person) => [person.did, person])),
    [people],
  )

  const setRow = (did: string, next: RowMode) => {
    setError(null)
    setMode((previous) => ({ ...previous, [did]: next }))
  }

  const run = async (did: string, action: () => Promise<void> | void) => {
    setBusy(did)
    setError(null)
    try {
      await action()
      setRow(did, { kind: "idle" })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not go through.")
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <p className="shr-empty" role="status">
        Checking who has access…
      </p>
    )
  }

  return (
    <div className={["shr-access", className ?? ""].join(" ")}>
      <ul className="shr-list">
        <li className="shr-row is-owner">
          <span className="shr-row-icon" aria-hidden="true">
            <RiStarLine />
          </span>
          <span className="shr-row-main">
            <span className="shr-row-name">
              {byDid.get(context.owner)?.label ?? "Owner"}
              {context.owner === actor && <span className="shr-you">you</span>}
            </span>
            <span className="shr-row-meta">
              Owns {resourceLabel}. Full access, and cannot be removed.
            </span>
          </span>
          <span className="shr-pill is-admin">Owner</span>
        </li>

        {entries
          .filter((entry) => entry.principal !== context.owner)
          .map((entry) => {
            const person = byDid.get(entry.principal)
            const plan = removalPlan(entry, resource, actor, context.owner)
            const rowMode = mode[entry.principal] ?? { kind: "idle" }
            const working = busy === entry.principal
            const canAct = plan.revoke.length > 0
            const inherited = entry.inheritedFrom !== null

            return (
              <li key={entry.principal} className={["shr-row", inherited ? "is-inherited" : ""].join(" ")}>
                <span className="shr-row-icon" aria-hidden="true">
                  {inherited ? <RiFolderSharedLine /> : <RiUser3Line />}
                </span>

                <span className="shr-row-main">
                  <span className="shr-row-name">
                    {person?.label ?? "Unnamed device"}
                    <IdentityBadge assurance={person?.assurance ?? "self-asserted"} />
                    {entry.principal === actor && <span className="shr-you">you</span>}
                  </span>

                  <span className="shr-row-meta">
                    <code className="shr-fingerprint">{fingerprints[entry.principal] ?? "…"}</code>
                  </span>

                  <span className="shr-row-route">
                    {inherited ? (
                      <>
                        Through <strong>{nameOf(entry.inheritedFrom ?? "")}</strong> — not granted on{" "}
                        {resourceLabel}
                      </>
                    ) : (
                      <>Granted on {resourceLabel}</>
                    )}
                    {entry.depth > 0 && (
                      <span className="shr-reshare" title="This grant may be passed on to others">
                        <RiShareForwardLine aria-hidden="true" /> can re-share
                      </span>
                    )}
                    {" · "}
                    Until {new Date(entry.expiresAt).toLocaleDateString()}
                  </span>

                  {rowMode.kind === "removing" && (
                    <span className="shr-confirm" role="alert">
                      <strong>
                        Remove {person?.label ?? "this device"} from{" "}
                        {plan.wider.length > 0 ? nameOf(entry.via.capability.payload.rsc) : resourceLabel}?
                      </strong>
                      {plan.wider.length > 0 && (
                        <span className="shr-confirm-line is-loud">
                          Their access comes from {entry.inheritedFrom ? nameOf(entry.inheritedFrom) : "a wider grant"}, so
                          removing it takes away everything under it, not only {resourceLabel}.
                        </span>
                      )}
                      {entry.grants.length > 1 && (
                        <span className="shr-confirm-line">
                          They hold {entry.grants.length} grants covering {resourceLabel}. All of
                          them are withdrawn, or the weaker one would leave access in place.
                        </span>
                      )}
                      {plan.partial && (
                        <span className="shr-confirm-line is-loud">
                          {plan.blocked.length} of their grants was issued by someone else. You
                          cannot withdraw it, so they keep access through it.
                        </span>
                      )}
                      <span className="shr-confirm-line">{REMOVAL_REALITY}</span>
                      <span className="shr-confirm-actions">
                        <Button data-style="ghost" onClick={() => setRow(entry.principal, { kind: "idle" })}>
                          <span className="tiptap-button-text">Keep access</span>
                        </Button>
                        <Button
                          className="shr-danger-btn"
                          disabled={working}
                          onClick={() => void run(entry.principal, () => onRevoke?.(entry, plan))}
                        >
                          <span className="tiptap-button-text">
                            {working ? "Removing…" : "Remove access"}
                          </span>
                        </Button>
                      </span>
                    </span>
                  )}

                  {rowMode.kind === "level" && (
                    <span className="shr-inline-editor">
                      <AccessLevelPicker
                        value={rowMode.ability}
                        max={(capped ? ceiling : held) ?? entry.ability}
                        ceilingReason={capped ? ceilingReason : budget?.reason}
                        {...(min ? { min } : {})}
                        {...(minReason ? { floorReason: minReason } : {})}
                        name={`level-${entry.principal.slice(-8)}`}
                        onChange={(ability) => setRow(entry.principal, { kind: "level", ability })}
                      />
                      <span className="shr-confirm-line">
                        Changing the level issues a new grant and withdraws the old one. The old one
                        stops working as the withdrawal reaches each device.
                      </span>
                      <span className="shr-confirm-actions">
                        <Button data-style="ghost" onClick={() => setRow(entry.principal, { kind: "idle" })}>
                          <span className="tiptap-button-text">Cancel</span>
                        </Button>
                        <Button
                          className="shr-primary-btn is-active"
                          disabled={working || rowMode.ability === entry.ability}
                          onClick={() =>
                            void run(entry.principal, () => onChangeLevel?.(entry, rowMode.ability))
                          }
                        >
                          <span className="tiptap-button-text">{working ? "Saving…" : "Save level"}</span>
                        </Button>
                      </span>
                    </span>
                  )}
                </span>

                <span className={["shr-pill", `is-${entry.ability}`].join(" ")}>
                  {ABILITY_COPY[entry.ability].short}
                </span>

                {rowMode.kind === "idle" && (
                  <span className="shr-row-actions">
                    {onChangeLevel && !inherited && canAct && (
                      <Button
                        data-style="ghost"
                        aria-label={`Change level for ${person?.label ?? entry.principal}`}
                        onClick={() => setRow(entry.principal, { kind: "level", ability: entry.ability })}
                      >
                        <span className="tiptap-button-text">Change</span>
                      </Button>
                    )}
                    {onRevoke && (
                      <Button
                        data-style="ghost"
                        disabled={!canAct}
                        tooltip={
                          canAct
                            ? undefined
                            : "You did not grant this access, so you cannot withdraw it."
                        }
                        aria-label={`Remove ${person?.label ?? entry.principal}`}
                        onClick={() => setRow(entry.principal, { kind: "removing" })}
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

      {entries.filter((entry) => entry.principal !== context.owner).length === 0 && (
        <p className="shr-empty" role="status">
          Nobody else has access to {resourceLabel}.
        </p>
      )}

      {error && (
        <span className="shr-error" role="alert">
          <RiAlertLine aria-hidden="true" /> {error}
        </span>
      )}
    </div>
  )
}

export default AccessList
