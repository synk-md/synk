"use client"

import * as React from "react"
import { RiShieldKeyholeLine } from "@remixicon/react"

import { deviceFingerprint, FINGERPRINT_PLACEHOLDER, fingerprintsMatch } from "@/lib/identity"

import "./identity.scss"

export type FingerprintCompareProps = {
  /** `did:key` whose fingerprint the person should be checking. */
  did: string
  /** Fires with true once what was typed matches, false when it stops matching. */
  onMatchChange: (matched: boolean) => void
  /** Wording above the displayed code. */
  prompt?: string
  /** What to do if the codes differ. Worth spelling out per context. */
  mismatchGuidance?: string
  disabled?: boolean
  inputId?: string
  className?: string
}

/**
 * Out-of-band verification: show a key's fingerprint, and make the person type
 * what they see on the other side.
 *
 * Typing rather than eyeballing is the point. A confirm button next to a
 * displayed code gets pressed without being read; entering sixteen characters
 * cannot be done without looking at both screens. A prefix does not count -
 * `fingerprintsMatch` requires the full length, or the length would buy nothing.
 *
 * Shared between approving a new device and admitting an invited person,
 * because it is the same check with different consequences, and a second
 * implementation is a second chance to weaken it.
 */
export function FingerprintCompare({
  did,
  onMatchChange,
  prompt = "Check the code on the other device",
  mismatchGuidance = "If the code on the other screen is different, stop — you are not talking to who you think.",
  disabled,
  inputId = "fingerprint-compare-input",
  className,
}: FingerprintCompareProps) {
  const [expected, setExpected] = React.useState<string | null>(null)
  const [typed, setTyped] = React.useState("")

  React.useEffect(() => {
    let cancelled = false
    setTyped("")
    setExpected(null)
    void deviceFingerprint(did).then((value) => {
      if (!cancelled) setExpected(value)
    })
    return () => {
      cancelled = true
    }
  }, [did])

  const matched = expected !== null && typed.length > 0 && fingerprintsMatch(typed, expected)

  // Report upward rather than holding the decision here: the parent owns what
  // a match unlocks, and it should not have to re-derive it.
  React.useEffect(() => {
    onMatchChange(matched)
  }, [matched, onMatchChange])

  const showMismatch = typed.length > 0 && !matched

  return (
    <div className={["idf-compare", className ?? ""].join(" ")}>
      <span className="idf-field-label">{prompt}</span>

      <div className="idf-fingerprint-display" aria-label="Expected fingerprint">
        <RiShieldKeyholeLine aria-hidden="true" />
        <code>{expected ?? "…"}</code>
      </div>

      <p className="idf-hint">{mismatchGuidance}</p>

      <label htmlFor={inputId} className="idf-field-label">
        Type it here to confirm
      </label>
      <input
        id={inputId}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={FINGERPRINT_PLACEHOLDER}
        className={["idf-input", showMismatch ? "is-error" : ""].join(" ")}
        disabled={disabled || expected === null}
        aria-invalid={showMismatch}
      />
      {showMismatch && (
        <span className="idf-error" role="alert">
          That does not match the code above.
        </span>
      )}
    </div>
  )
}

export default FingerprintCompare
