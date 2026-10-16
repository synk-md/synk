"use client"

import { RiAlertLine, RiCheckLine, RiLoader4Line } from "@remixicon/react"

import type { AdmissionRun } from "@/hooks/use-note-admission"

import "./members.scss"

export type AdmissionProgressProps = {
  run: AdmissionRun
  onCancel?: () => void
  className?: string
}

/**
 * How far along covering a notebook's notes has got.
 *
 * Shown because the work is open-ended - a notebook is as many documents as it
 * is - and because it is separable from the grant. The person is already a
 * member; what is still happening is making the notebook *readable* to them, so
 * the wording says that rather than implying the admission is incomplete.
 *
 * Notes still outstanding are named. Someone who closed the tab halfway should
 * be able to tell which notes the new member cannot yet see, rather than being
 * told a number.
 */
export function AdmissionProgress({ run, onCancel, className }: AdmissionProgressProps) {
  if (!run.progress && !run.error) return null

  const progress = run.progress
  const done = progress ? progress.done + progress.skipped : 0
  const total = progress?.total ?? 0
  const complete = !run.running && run.outstanding.length === 0 && !run.error

  return (
    <div
      className={["mem-admission", run.error ? "is-error" : "", className ?? ""].join(" ")}
      role="status"
      aria-live="polite"
    >
      <span className="mem-admission-icon" aria-hidden="true">
        {run.error ? <RiAlertLine /> : complete ? <RiCheckLine /> : <RiLoader4Line />}
      </span>

      <div className="mem-admission-body">
        {run.error ? (
          <>
            <strong>Could not finish making the notes readable.</strong>
            <span className="mem-note">{run.error}</span>
          </>
        ) : complete ? (
          <strong>
            {total === 0
              ? "Nothing needed covering."
              : total === 1
                ? "The note is readable to them."
                : `All ${String(total)} notes are readable to them.`}
          </strong>
        ) : (
          <>
            <strong>
              Making the notes readable — {String(done)} of {String(total)}
            </strong>
            <span className="mem-note">
              They are already a member. This is the part that lets them open what was
              written before they joined, and it can be left to finish later.
            </span>
          </>
        )}

        {progress && progress.failed > 0 && (
          <span className="mem-note is-loud">
            {progress.failed} could not be covered and will be retried.
          </span>
        )}

        {!run.running && run.outstanding.length > 0 && (
          <span className="mem-note">
            Still unreadable to them: {run.outstanding.slice(0, 6).join(", ")}
            {run.outstanding.length > 6 ? ` and ${String(run.outstanding.length - 6)} more` : ""}.
          </span>
        )}

        {run.running && !run.offThread && (
          <span className="mem-note">
            This browser cannot do the work in the background, so the page may be slow
            until it finishes.
          </span>
        )}
      </div>

      {run.running && onCancel && (
        <button type="button" className="mem-admission-cancel" onClick={onCancel}>
          Stop
        </button>
      )}
    </div>
  )
}

export default AdmissionProgress
