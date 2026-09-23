"use client"

import * as React from "react"
import { RiAlertLine, RiCloseLine, RiInformationLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { useAccessSummary, useGrantBudget } from "@/hooks/use-access"
import { useFingerprints } from "@/hooks/use-device-identity"
import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"

import { ABILITY_COPY, ADMIN_WARNING, REDELEGATION_NOTE } from "./ability-copy"
import { AccessLevelPicker } from "./access-level-picker"
import { abilityStrength, type GrantRequest, type Person } from "./access-model"

import "./sharing.scss"

export type ShareScope = {
  /** Resource id the grant would name. */
  resource: string
  /** How it reads in a sentence: "this note", "the whole notebook". */
  label: string
  /** What it actually reaches. The part people misjudge, so it is spelled out. */
  covers: string
}

export type ShareDialogProps = {
  open: boolean
  onClose: () => void
  /**
   * Narrowest first. The first entry is the default, so opening this from a
   * note offers the note before the notebook.
   */
  scopes: readonly ShareScope[]
  /** People who could be granted access, from the directory. */
  candidates: readonly Person[]
  /** Everything known, so existing access can be checked before granting more. */
  capabilities: readonly Capability[]
  context: AuthorizationContext
  actor: string
  onGrant: (request: GrantRequest) => Promise<void> | void
  className?: string
}

const DAY = 24 * 60 * 60 * 1000
const DURATIONS: readonly { label: string; ms: number }[] = [
  { label: "7 days", ms: 7 * DAY },
  { label: "30 days", ms: 30 * DAY },
  { label: "90 days", ms: 90 * DAY },
  { label: "1 year", ms: 365 * DAY },
]

/**
 * Granting access.
 *
 * Three things go wrong in a share dialog, and the layout is arranged around
 * them rather than around the form fields.
 *
 * *Granting the wrong level.* Every level's consequence is on screen at the
 * moment of choosing, and levels beyond what this person may grant are shown
 * locked rather than hidden.
 *
 * *Granting on the wrong thing.* Scope is an explicit choice, narrowest first,
 * and each option says what it reaches - a notebook grant covers notes that do
 * not exist yet, which is the part nobody expects.
 *
 * *Believing a narrow grant limits someone.* It does not. A new grant only ever
 * adds. If the chosen person already has wider access, that is shown before the
 * button, because adding read on one note to someone holding edit on the
 * notebook changes nothing at all.
 */
export function ShareDialog({
  open,
  onClose,
  scopes,
  candidates,
  capabilities,
  context,
  actor,
  onGrant,
  className,
}: ShareDialogProps) {
  const [scopeIndex, setScopeIndex] = React.useState(0)
  const [audience, setAudience] = React.useState<string | null>(null)
  const [ability, setAbility] = React.useState<Ability>("read")
  const [redelegate, setRedelegate] = React.useState(false)
  const [durationMs, setDurationMs] = React.useState(DURATIONS[1].ms)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)]
  const { budget, loading } = useGrantBudget(actor, scope.resource, context)
  const { entries } = useAccessSummary(capabilities, scope.resource, context)

  const dids = React.useMemo(() => candidates.map((person) => person.did), [candidates])
  const fingerprints = useFingerprints(dids)

  React.useEffect(() => {
    if (open) return
    setScopeIndex(0)
    setAudience(null)
    setAbility("read")
    setRedelegate(false)
    setDurationMs(DURATIONS[1].ms)
    setBusy(false)
    setError(null)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose])

  // Re-sharing cannot survive a budget that has none left to pass on, and a
  // checkbox left ticked while unavailable would grant something it did not say.
  React.useEffect(() => {
    if (budget && budget.maxDepth < 1) setRedelegate(false)
  }, [budget])

  if (!open) return null

  const maxAbility = budget?.maxAbility ?? null
  const clampedAbility: Ability =
    maxAbility && abilityStrength(ability) > abilityStrength(maxAbility) ? maxAbility : ability
  const expiresAt = budget ? Math.min(budget.notBefore + durationMs, budget.notAfter) : 0
  const cappedByProof = budget !== null && budget.notBefore + durationMs > budget.notAfter
  const existing = entries.find((entry) => entry.principal === audience)
  const wouldNotReduce =
    existing !== undefined && abilityStrength(existing.ability) >= abilityStrength(clampedAbility)

  const grant = async () => {
    if (!audience || !budget || maxAbility === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await onGrant({
        audience,
        resource: scope.resource,
        ability: clampedAbility,
        depth: redelegate ? budget.maxDepth : 0,
        expiresAt,
        proof: budget.proof,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not share this.")
      setBusy(false)
    }
  }

  return (
    <div
      className="shr-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["shr-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-heading"
      >
        <div className="shr-header">
          <div className="shr-heading">
            <h3 id="share-heading">Share {scope.label}</h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        {!loading && maxAbility === null ? (
          <div className="shr-warning is-critical" role="alert">
            <span className="shr-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>You cannot share this.</strong>
              <p>{budget?.reason}</p>
            </div>
          </div>
        ) : (
          <>
            <span className="shr-field-label">Who</span>
            {candidates.length === 0 ? (
              <p className="shr-empty">
                Nobody to share with yet. Invite someone first, and they will appear here.
              </p>
            ) : (
              <ul className="shr-candidates" role="listbox" aria-label="Who to share with">
                {candidates.map((person) => (
                  <li key={person.did}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={audience === person.did}
                      className={["shr-candidate", audience === person.did ? "is-selected" : ""].join(" ")}
                      onClick={() => setAudience(person.did)}
                    >
                      <span className="shr-candidate-main">
                        <span className="shr-row-name">
                          {person.label}
                          <IdentityBadge assurance={person.assurance} />
                        </span>
                        <code className="shr-fingerprint">{fingerprints[person.did] ?? "…"}</code>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Shown before the level, not after: what someone already has is
                what decides whether this grant means anything. */}
            {existing && (
              <div className={["shr-warning", wouldNotReduce ? "is-critical" : ""].join(" ")} role="note">
                <span className="shr-warning-icon" aria-hidden="true">
                  <RiInformationLine />
                </span>
                <div>
                  <strong>
                    They already have {ABILITY_COPY[existing.ability].short.toLowerCase()} here
                    {existing.inheritedFrom ? `, through ${existing.inheritedFrom}` : ""}.
                  </strong>
                  <p>
                    {wouldNotReduce
                      ? "Sharing again adds a grant; it does not take the wider one away. To reduce what they can do, remove that grant instead."
                      : "This will sit alongside what they have, and the stronger one wins."}
                  </p>
                </div>
              </div>
            )}

            {scopes.length > 1 && (
              <>
                <span className="shr-field-label">What they get access to</span>
                <div className="shr-scopes" role="radiogroup" aria-label="Scope">
                  {scopes.map((option, index) => (
                    <label
                      key={option.resource}
                      htmlFor={`scope-${option.resource}`}
                      className={["shr-scope", scopeIndex === index ? "is-selected" : ""].join(" ")}
                    >
                      <input
                        id={`scope-${option.resource}`}
                        type="radio"
                        name="share-scope"
                        checked={scopeIndex === index}
                        onChange={() => setScopeIndex(index)}
                      />
                      <span className="shr-level-body">
                        <span className="shr-level-label">{option.label}</span>
                        <span className="shr-level-consequence">{option.covers}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <span className="shr-field-label">What they can do</span>
            <AccessLevelPicker
              value={clampedAbility}
              onChange={setAbility}
              max={maxAbility ?? "read"}
              ceilingReason={budget?.reason}
              name="share-level"
              disabled={busy}
            />

            {clampedAbility === "admin" && (
              <div className="shr-warning" role="note">
                <span className="shr-warning-icon" aria-hidden="true">
                  <RiAlertLine />
                </span>
                <div>
                  <strong>Manage access is the one worth pausing over.</strong>
                  <p>{ADMIN_WARNING}</p>
                </div>
              </div>
            )}

            <label className={["shr-check", budget && budget.maxDepth < 1 ? "is-locked" : ""].join(" ")}>
              <input
                type="checkbox"
                checked={redelegate}
                disabled={busy || !budget || budget.maxDepth < 1}
                onChange={(event) => setRedelegate(event.target.checked)}
              />
              <span>
                <span className="shr-check-label">Let them share this on</span>
                <span className="shr-level-consequence">
                  {budget && budget.maxDepth < 1
                    ? "Not available — your own access cannot be passed on any further."
                    : REDELEGATION_NOTE}
                </span>
              </span>
            </label>

            <span className="shr-field-label">For how long</span>
            <div className="shr-durations" role="radiogroup" aria-label="Duration">
              {DURATIONS.map((duration) => (
                <label
                  key={duration.label}
                  htmlFor={`duration-${duration.ms}`}
                  className={["shr-duration", durationMs === duration.ms ? "is-selected" : ""].join(" ")}
                >
                  <input
                    id={`duration-${duration.ms}`}
                    type="radio"
                    name="share-duration"
                    checked={durationMs === duration.ms}
                    onChange={() => setDurationMs(duration.ms)}
                  />
                  {duration.label}
                </label>
              ))}
            </div>
            <p className="shr-hint">
              Access ends {expiresAt ? new Date(expiresAt).toLocaleDateString() : "—"}.
              {cappedByProof && " Shortened to match your own access, which ends then."}
            </p>

            {error && (
              <span className="shr-error" role="alert">
                <RiAlertLine aria-hidden="true" /> {error}
              </span>
            )}

            <div className="shr-actions">
              <Button data-style="ghost" onClick={onClose}>
                <span className="tiptap-button-text">Cancel</span>
              </Button>
              <Button
                className={["shr-primary-btn", audience ? "is-active" : ""].join(" ")}
                disabled={!audience || busy || loading}
                onClick={() => void grant()}
              >
                <span className="tiptap-button-text">
                  {busy
                    ? "Sharing…"
                    : `Give ${ABILITY_COPY[clampedAbility].short.toLowerCase()} on ${scope.label}`}
                </span>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default ShareDialog
