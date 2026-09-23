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
  pending?: readonly PendingRemoval[]
  /** What this device holds, for confirming a removal landed. */
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
 * What is true about a removal now, and what is merely on its way.
 *
 * A lingering removed member is expected, and is also what a withheld
 * revocation looks like, so the two are told apart by the freshness summary
 * rather than by a timer.
 *
 * All three phases repeat that reading stopped immediately. That the member can
 * still see everything is the one reading that is never correct, and leaving it
 * unsaid is what makes ordinary latency alarming.
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

      {/* Repeating "up to date" beside every settled removal is noise. */}
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
