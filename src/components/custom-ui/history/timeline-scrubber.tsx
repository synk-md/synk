"use client"

import * as React from "react"
import {
  RiBookmark3Line,
  RiEdit2Line,
  RiEyeOffLine,
  RiGitCommitLine,
  RiHistoryLine,
  RiKey2Line,
  RiArchiveLine,
} from "@remixicon/react"

import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"
import type { RestorePoint } from "@/lib/history"

import "./history.scss"

export type TimelineScrubberProps = {
  points: readonly RestorePoint[]
  selectedId?: string | null
  onSelect: (point: RestorePoint) => void
  now?: number
  className?: string
}

const KIND_ICON: Record<RestorePoint["kind"], React.ReactNode> = {
  checkpoint: <RiBookmark3Line />,
  join: <RiKey2Line />,
  promotion: <RiKey2Line />,
  automatic: <RiGitCommitLine />,
  session: <RiEdit2Line />,
}

const TITLE: Record<RestorePoint["kind"], string> = {
  checkpoint: "Checkpoint",
  join: "Saved point",
  promotion: "Saved point",
  automatic: "Saved point",
  session: "Edits",
}

function when(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${String(minutes)} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${String(hours)} hours ago`
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function blockerNote(point: RestorePoint): string | null {
  switch (point.blocker) {
    case "outside-visible-history":
      return "From before you had access — you cannot open this one."
    case "payload-archived":
      return "Kept as a marker. The contents are in the archive."
    case "current":
      return "Where the document is now."
    case null:
      return null
  }
}

/**
 * The history, as a list of points you can go back to.
 *
 * Every point carries a byline, and the byline is a view of a signing key
 * rather than a name someone typed. Points from before this member had access
 * are listed and marked unopenable: the history exists, and hiding it would be
 * a more comfortable lie than saying so.
 *
 * A conflicted byline renders as unverified rather than taking the list down
 * with it.
 */
export function TimelineScrubber({
  points,
  selectedId,
  onSelect,
  now = Date.now(),
  className,
}: TimelineScrubberProps) {
  if (points.length === 0) {
    return (
      <p className="hx-empty" role="status">
        No restore points yet. Name one to keep the note as it is now.
      </p>
    )
  }

  return (
    <ol className={["hx-timeline", className ?? ""].join(" ")} aria-label="Restore points">
      {points.map((point) => {
        const note = blockerNote(point)
        const selected = point.id === selectedId

        return (
          <li
            key={point.id}
            className={[
              "hx-point",
              selected ? "is-selected" : "",
              point.restorable ? "" : "is-blocked",
              point.blocker === "current" ? "is-current" : "",
            ].join(" ")}
          >
            <button
              type="button"
              className="hx-point-button"
              aria-current={point.blocker === "current" ? "true" : undefined}
              aria-pressed={selected}
              onClick={() => onSelect(point)}
            >
              <span className="hx-rail" aria-hidden="true">
                <span className="hx-node">
                  {point.blocker === "outside-visible-history" ? (
                    <RiEyeOffLine />
                  ) : point.blocker === "payload-archived" ? (
                    <RiArchiveLine />
                  ) : (
                    KIND_ICON[point.kind]
                  )}
                </span>
              </span>

              <span className="hx-point-body">
                <span className="hx-point-title">
                  {point.label ?? TITLE[point.kind]}
                  {point.kind === "checkpoint" && point.label && (
                    <span className="hx-chip">Named</span>
                  )}
                  {point.kind === "session" && point.changes !== undefined && (
                    <span className="hx-chip">
                      {point.changes === 1 ? "1 change" : `${String(point.changes)} changes`}
                    </span>
                  )}
                  {(point.kind === "join" || point.kind === "promotion") && (
                    <span className="hx-chip" title="Taken because who can see this changed">
                      Access change
                    </span>
                  )}
                </span>

                <span className="hx-point-meta">
                  <span className="hx-byline">
                    {point.attribution.label}
                    <IdentityBadge assurance={point.attribution.assurance} />
                  </span>
                  <span className="hx-when" title={new Date(point.createdAt).toLocaleString()}>
                    {when(point.createdAt, now)}
                  </span>
                </span>

                {point.attribution.conflict && (
                  <span className="hx-note is-loud">
                    Two admins recorded different names for this person:{" "}
                    {point.attribution.conflict.join(", ")}. Treat the byline as unconfirmed.
                  </span>
                )}

                {note && <span className="hx-note">{note}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export function TimelineHeading({ count }: { count: number }) {
  return (
    <h4 className="hx-heading">
      <RiHistoryLine aria-hidden="true" />
      {count === 1 ? "1 restore point" : `${String(count)} restore points`}
    </h4>
  )
}

export default TimelineScrubber
