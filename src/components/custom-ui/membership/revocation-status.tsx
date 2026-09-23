"use client"

import * as React from "react"
import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiEyeOffLine,
  RiLoader4Line,
  RiQuillPenLine,
} from "@remixicon/react"

import type { FreshnessAssessment } from "@/lib/membership"

import {
  freshnessCopy,
  removalProgress,
  type PendingRemoval,
  type RemovalProgress,
} from "./membership-model"

import "./membership.scss"

export type RevocationStatusProps = {
  assessment: FreshnessAssessment
  /** Removals made recently enough to still be in flight. */
  pending?: readonly PendingRemoval[]
  /** The revocation ids this device holds, for confirming a removal landed. */
  localRevokedIds?: readonly string[]
  now?: number
  className?: string
}

const ICON: Record<RemovalProgress["phase"], React.ReactNode> = {
  settled: <RiCheckboxCircleLine />,
  settling: <RiLoader4Line />,
  unconfirmable: <RiErrorWarningLine />,
}

/**
 * What is true right now about removals, and what is merely on its way.
 *
 * A removed member lingers. Their name stays in a presence list for a while and
 * a peer that has not caught up keeps accepting their edits. That is expected,
 * and it is also exactly what a withheld revocation looks like, so the two have
 * to be told apart rather than both being shown as "removing…".
 *
 * The signal that separates them is the freshness summary, not a timer. A
 * removal is *settled* when the relay's own published set is known to contain
 * the withdrawal; it is *settling* while the summary is fresh and the wait is
 * still ordinary; and it is *unconfirmable* when the summary has stopped
 * advancing, gone backwards, or disagrees with what this device holds.
 *
 * Under all three, one thing is unconditionally true and is said every time:
 * **reading stopped immediately**. The epoch rotated, so it does not matter
 * whether a single peer ever hears about the revocation. The frightening
 * reading of a lingering member - that they can still see everything - is the
 * one interpretation that is never correct, and leaving it unsaid is what makes
 * ordinary latency alarming.
 */
export function RevocationStatus({
  assessment,
  pending = [],
  localRevokedIds = [],
  now = Date.now(),
  className,
}: RevocationStatusProps) {
  const copy = freshnessCopy(assessment)
  const progress = pending.map((removal) => ({
    removal,
    progress: removalProgress(removal, assessment, localRevokedIds, now),
  }))
  const unconfirmable = progress.filter(({ progress: p }) => p.needsAttention)

  return (
    <section
      className={["mb-revocation", className ?? ""].join(" ")}
      aria-label="Removal status"
    >
      {pending.length > 0 && (
        <ul className="mb-pending-list">
          {progress.map(({ removal, progress: p }) => (
            <li
              key={`${removal.label}-${String(removal.removedAt)}`}
              className={["mb-pending", `is-${p.phase}`].join(" ")}
            >
              <span className="mb-pending-icon" aria-hidden="true">
                {ICON[p.phase]}
              </span>
              <span className="mb-pending-body">
                <strong>{p.headline}</strong>
                <span className="mb-pending-detail">{p.detail}</span>

                {/* The two halves of removal have different timelines, and the
                    one that is instant is the one people assume is not. */}
                <span className="mb-effects">
                  <span className="mb-effect is-done">
                    <RiEyeOffLine aria-hidden="true" />
                    Reading: stopped immediately
                  </span>
                  <span
                    className={["mb-effect", p.writesBlockedEverywhere ? "is-done" : "is-waiting"].join(" ")}
                  >
                    <RiQuillPenLine aria-hidden="true" />
                    Writing: {p.writesBlockedEverywhere ? "stopped everywhere" : "stopping as devices catch up"}
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The freshness line is shown on its own only when there is nothing
          pending, or when it is bad enough to matter regardless. Repeating
          "up to date" beside every settled removal is noise. */}
      {(pending.length === 0 || (copy.tone !== "ok" && unconfirmable.length === 0)) && (
        <div className={["mb-freshness", `is-${copy.tone}`].join(" ")} role={copy.tone === "alarm" ? "alert" : "status"}>
          <span className="mb-freshness-icon" aria-hidden="true">
            {copy.tone === "ok" ? <RiCheckboxCircleLine /> : <RiErrorWarningLine />}
          </span>
          <span>
            <strong>{copy.headline}</strong>
            <span className="mb-pending-detail">{copy.detail}</span>
          </span>
        </div>
      )}
    </section>
  )
}

export default RevocationStatus
