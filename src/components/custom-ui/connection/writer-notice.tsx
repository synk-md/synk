"use client"

import { RiAlertLine, RiFileCopyLine, RiUserUnfollowLine } from "@remixicon/react"

import type { DocBinding } from "@/lib/doc-binding"

import "./connection.scss"

export type WriterNoticeProps = {
  binding: DocBinding
  className?: string
}

/**
 * Why this tab is read-only.
 *
 * Both cases are the cost of a stable, derived client id, and both would
 * otherwise look like the app silently dropping typing. A tab that cannot write
 * has to say so, because nothing else on screen distinguishes it from one that
 * can.
 */
export function WriterNotice({ binding, className }: WriterNoticeProps) {
  if (binding.status !== "follower" && binding.status !== "regressed") return null

  const follower = binding.status === "follower"

  return (
    <div
      className={["cx-banner", follower ? "" : "is-critical", className ?? ""].join(" ")}
      role={follower ? "status" : "alert"}
    >
      <span className="cx-banner-icon" aria-hidden="true">
        {follower ? <RiFileCopyLine /> : <RiAlertLine />}
      </span>
      <div className="cx-banner-body">
        <strong>
          {follower
            ? "Open in another tab — this one is read-only"
            : "This note is read-only on this device"}
        </strong>
        <span>
          {follower
            ? "Your notes are edited in one tab at a time so two copies cannot write over each other. Close the other tab, or keep working there."
            : `${binding.detail ?? ""} Nothing has been lost. Editing from another device is unaffected, and this one recovers once it has caught up.`}
        </span>
      </div>
    </div>
  )
}

export default WriterNotice

/**
 * This device was removed from the notebook.
 *
 * Read-only rather than quietly editable: typing into a copy that reaches
 * nobody is the failure that looks like sync working, and it would also be
 * published by surprise if they were ever let back in.
 */
export function RemovedNotice({ className }: { className?: string }) {
  return (
    <div className={["cx-banner", "is-critical", className ?? ""].join(" ")} role="alert">
      <span className="cx-banner-icon" aria-hidden="true">
        <RiUserUnfollowLine />
      </span>
      <div className="cx-banner-body">
        <strong>You no longer have access to this notebook</strong>
        <span>
          Its owner removed you. What is already on this device stays here to read, but nothing
          written from now on reaches you, and nothing written here would reach anyone.
        </span>
      </div>
    </div>
  )
}
