"use client"

import * as React from "react"
import { RiBookmark3Line, RiEyeOffLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  historyHorizon,
  resolveAttribution,
  type RestorePlan,
  type RestorePoint,
  type TimelineAttribution,
} from "@/lib/history"
import type { User } from "@/lib/identity"

import { CheckpointDialog } from "./checkpoint-dialog"
import { RestoreDialog } from "./restore-dialog"
import { TimelineHeading, TimelineScrubber } from "./timeline-scrubber"

import "./history.scss"

export type HistoryPanelProps = {
  points: readonly RestorePoint[]
  users: readonly User[]
  /** Runs the plan for a point. Async because opening a snapshot is. */
  onPlan: (point: RestorePoint) => Promise<RestorePlan>
  onRestore: (point: RestorePoint) => Promise<void> | void
  onCheckpoint: (label: string) => Promise<void> | void
  /** Yjs client ids to device keys, for naming the original authors. */
  clientToDid?: ReadonlyMap<number, string>
  now?: number
  className?: string
}

/**
 * The history, the restore action and checkpoint creation in one place.
 *
 * Choosing a point runs the plan before the confirmation is shown, so what the
 * dialog promises is what the restore will actually do rather than a guess
 * refined after the fact.
 */
export function HistoryPanel({
  points,
  users,
  onPlan,
  onRestore,
  onCheckpoint,
  clientToDid,
  now = Date.now(),
  className,
}: HistoryPanelProps) {
  const [selected, setSelected] = React.useState<RestorePoint | null>(null)
  const [plan, setPlan] = React.useState<RestorePlan | null>(null)
  const [planning, setPlanning] = React.useState(false)
  const [naming, setNaming] = React.useState(false)
  const [planError, setPlanError] = React.useState<string | null>(null)

  const horizon = historyHorizon(points)

  const choose = React.useCallback(
    (point: RestorePoint) => {
      setSelected(point)
      setPlan(null)
      setPlanError(null)
      if (!point.restorable) return

      setPlanning(true)
      void onPlan(point)
        .then((result) => {
          setPlan(result)
        })
        .catch((cause: unknown) => {
          setPlanError(cause instanceof Error ? cause.message : "Could not read that point.")
        })
        .finally(() => {
          setPlanning(false)
        })
    },
    [onPlan],
  )

  // The original authors of the content coming back, named where the directory
  // knows them. Falls back to the key, never to a guess.
  const origins: TimelineAttribution[] = React.useMemo(() => {
    if (!plan || !clientToDid) return []
    return plan.regions
      .map((region) => clientToDid.get(region.originClientId))
      .filter((did): did is string => typeof did === "string")
      .map((did) => resolveAttribution(did, users))
  }, [plan, clientToDid, users])

  return (
    <div className={["hx-panel", className ?? ""].join(" ")}>
      <div className="hx-panel-header">
        <TimelineHeading count={points.length} />
        <Button data-style="ghost" onClick={() => setNaming(true)}>
          <RiBookmark3Line className="tiptap-button-icon" />
          <span className="tiptap-button-text">Name this point</span>
        </Button>
      </div>

      {horizon && (
        <p className="hx-horizon">
          <RiEyeOffLine aria-hidden="true" />
          The document existed before you had access. Those points are listed, but cannot be opened
          from this device.
        </p>
      )}

      <TimelineScrubber
        points={points}
        selectedId={selected?.id ?? null}
        onSelect={choose}
        now={now}
      />

      {planError && (
        <span className="hx-error" role="alert">
          {planError}
        </span>
      )}

      <RestoreDialog
        open={selected !== null}
        onClose={() => {
          setSelected(null)
          setPlan(null)
        }}
        point={selected}
        plan={plan}
        planning={planning}
        origins={origins}
        onRestore={onRestore}
      />

      <CheckpointDialog open={naming} onClose={() => setNaming(false)} onCreate={onCheckpoint} />
    </div>
  )
}

export default HistoryPanel
