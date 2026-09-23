"use client"

import * as React from "react"
import { RiAlertLine, RiCloseLine, RiHistoryLine, RiKey2Line } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import { AccessLevelPicker } from "@/components/custom-ui/sharing/access-level-picker"
import { useFingerprints } from "@/hooks/use-device-identity"
import type { Ability } from "@/lib/authz"

import type { MemberView } from "./membership-model"

import "./membership.scss"

export type AdmissionRequest = {
  member: MemberView
  /** The device key the capability is addressed to. */
  joinerDid: string
  /** Where their copy of the content key is sealed. */
  joinerSealingDid: string
  ability: Ability
  expiresAt: number
}

export type AdmitMemberDialogProps = {
  open: boolean
  onClose: () => void
  member: MemberView | null
  /** How the resource reads in a sentence: "this notebook". */
  resourceLabel: string
  onAdmit: (request: AdmissionRequest) => Promise<void> | void
  /** Highest level this admin may confer. */
  maxAbility?: Ability
  now?: number
  className?: string
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Letting a person into a notebook's contents.
 *
 * This is not the same step as admitting them to the workspace, and conflating
 * the two is the mistake it is shaped to avoid. Workspace admission established
 * *who they are*; this hands over *keys*. Someone can be a perfectly legitimate
 * member of the workspace and have no business reading this notebook.
 *
 * Two consequences are stated before the button rather than after.
 *
 * They receive the notebook as it stands now, in full. Admission cuts a fresh
 * epoch and seals a snapshot of the current document under it, so there is no
 * such thing as admitting someone to "only what happens next" - whatever is in
 * there is theirs to read the moment they are let in.
 *
 * They do not receive the edit history from before now. Earlier updates are
 * sealed under earlier keys they cannot derive. Saying so stops both wrong
 * assumptions: that admission is retroactive, and that it is not.
 */
export function AdmitMemberDialog({
  open,
  onClose,
  member,
  resourceLabel,
  onAdmit,
  maxAbility = "admin",
  now = Date.now(),
  className,
}: AdmitMemberDialogProps) {
  const [ability, setAbility] = React.useState<Ability>("read")
  const [days, setDays] = React.useState(365)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const devices = React.useMemo(
    () => (member?.devices ?? []).filter((device) => device.kind === "admitted"),
    [member],
  )
  const [target, setTarget] = React.useState<string | null>(null)
  const fingerprints = useFingerprints(
    React.useMemo(() => devices.map((device) => device.record.did), [devices]),
  )

  React.useEffect(() => {
    setAbility("read")
    setDays(365)
    setBusy(false)
    setError(null)
    setTarget(devices[0]?.record.did ?? null)
  }, [member, devices])

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

  if (!open || !member) return null

  const device = devices.find((candidate) => candidate.record.did === target)

  const admit = async () => {
    if (!device || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdmit({
        member,
        joinerDid: device.record.did,
        joinerSealingDid: device.record.sealingDid,
        ability,
        expiresAt: now + days * DAY,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not admit this member.")
      setBusy(false)
    }
  }

  // `assertKeyringCurrent` throws before anything is cut when the admin's view
  // is behind. It is the one failure with a specific remedy, so it gets one.
  const stale = error !== null && /keyring|epoch/i.test(error)

  return (
    <div
      className="mb-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={["mb-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admit-member-heading"
      >
        <div className="mb-header">
          <div className="mb-heading">
            <h3 id="admit-member-heading">Give {member.label} access?</h3>
          </div>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        <div className="mb-subject">
          <span className="mb-subject-name">{member.label}</span>
          <IdentityBadge assurance={member.assurance} />
        </div>

        {member.labelConflict && (
          <div className="mb-warning is-critical" role="alert">
            <span className="mb-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>Two admins gave this member different names.</strong>
              <p>
                {member.labelConflict.join(" and ")}. Sort that out before handing over keys — you
                may not be admitting who you think.
              </p>
            </div>
          </div>
        )}

        <p className="mb-body-text">
          They are already in this workspace. This is separate: it hands them the keys to{" "}
          {resourceLabel}.
        </p>

        <ul className="mb-effects-table">
          <li>
            <span className="mb-effect-icon" aria-hidden="true">
              <RiKey2Line />
            </span>
            <span>
              <strong>They get {resourceLabel} as it stands now, in full.</strong>
              <span className="mb-note">
                A snapshot of the current contents is sealed for them as part of letting them in.
                There is no way to admit someone to only what happens next.
              </span>
            </span>
          </li>
          <li>
            <span className="mb-effect-icon" aria-hidden="true">
              <RiHistoryLine />
            </span>
            <span>
              <strong>They do not get the edit history from before today.</strong>
              <span className="mb-note">
                Earlier updates stay sealed under keys they cannot work out from the one they are
                given.
              </span>
            </span>
          </li>
        </ul>

        {devices.length > 1 && (
          <>
            <span className="mb-field-label">Which of their devices</span>
            <ul className="mb-device-choice" role="radiogroup" aria-label="Device to admit">
              {devices.map((candidate) => (
                <li key={candidate.record.did}>
                  <label
                    htmlFor={`admit-${candidate.record.did}`}
                    className={["mb-device-option", target === candidate.record.did ? "is-selected" : ""].join(" ")}
                  >
                    <input
                      id={`admit-${candidate.record.did}`}
                      type="radio"
                      name="admit-device"
                      checked={target === candidate.record.did}
                      onChange={() => setTarget(candidate.record.did)}
                    />
                    <span>
                      <span className="mb-device-name">{candidate.admission.label}</span>
                      <code className="mb-fingerprint">
                        {fingerprints[candidate.record.did] ?? "…"}
                      </code>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {devices.length === 0 && (
          <div className="mb-warning is-critical" role="alert">
            <span className="mb-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>They have no admin-admitted device.</strong>
              <p>
                There is no key to seal to. They need to be admitted to the workspace first, or
                re-admitted if they lost every device.
              </p>
            </div>
          </div>
        )}

        <span className="mb-field-label">What they can do</span>
        <AccessLevelPicker value={ability} onChange={setAbility} max={maxAbility} name="admit-level" disabled={busy} />

        <span className="mb-field-label">For how long</span>
        <div className="mb-durations" role="radiogroup" aria-label="Duration">
          {[30, 90, 365].map((option) => (
            <label
              key={option}
              htmlFor={`admit-days-${String(option)}`}
              className={["mb-duration", days === option ? "is-selected" : ""].join(" ")}
            >
              <input
                id={`admit-days-${String(option)}`}
                type="radio"
                name="admit-duration"
                checked={days === option}
                onChange={() => setDays(option)}
              />
              {option === 365 ? "1 year" : `${String(option)} days`}
            </label>
          ))}
        </div>

        {error && (
          <div className={["mb-warning", "is-critical"].join(" ")} role="alert">
            <span className="mb-warning-icon" aria-hidden="true">
              <RiAlertLine />
            </span>
            <div>
              <strong>{stale ? "Your copy of the keys is out of date." : "That did not go through."}</strong>
              <p>
                {stale
                  ? "Nothing was handed over. Let this device finish catching up and try again — admitting from an out-of-date view would give them a key that has already been replaced."
                  : error}
              </p>
            </div>
          </div>
        )}

        <div className="mb-actions">
          <Button data-style="ghost" onClick={onClose}>
            <span className="tiptap-button-text">Cancel</span>
          </Button>
          <Button
            className={["mb-primary-btn", device ? "is-active" : ""].join(" ")}
            disabled={!device || busy}
            onClick={() => void admit()}
          >
            <span className="tiptap-button-text">{busy ? "Admitting…" : "Give access"}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AdmitMemberDialog
