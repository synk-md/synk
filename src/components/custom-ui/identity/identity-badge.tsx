"use client"

import { RiShieldCheckLine, RiMailSendLine, RiQuestionLine } from "@remixicon/react"

import "./identity.scss"

/**
 * How much a displayed name is worth: chosen by the subject, intended by an
 * admin, or checked against a key. Only `verified` ties a name to a key.
 *
 * `invited` is the one that misleads unlabelled - the name came from a trusted
 * person, just not about the party in front of you.
 */
export type IdentityAssurance = "self-asserted" | "invited" | "verified"

export type IdentityBadgeProps = {
  assurance: IdentityAssurance
  /** Shown instead of the default wording. */
  label?: string
  className?: string
}

const COPY: Record<IdentityAssurance, { text: string; title: string }> = {
  "self-asserted": {
    text: "Unverified",
    title: "This name was chosen by whoever is joining. Nothing has been checked.",
  },
  invited: {
    text: "Unverified",
    title:
      "This is the name on the invitation you sent. It does not confirm who redeemed it — check the fingerprint.",
  },
  verified: {
    text: "Verified",
    title: "The key fingerprint was confirmed out of band.",
  },
}

/** Both weak levels read "Unverified" and differ only in the explanation. */
export function IdentityBadge({ assurance, label, className }: IdentityBadgeProps) {
  const copy = COPY[assurance]
  const verified = assurance === "verified"

  return (
    <span
      className={[
        "idf-badge",
        verified ? "is-verified" : "is-unverified",
        className ?? "",
      ].join(" ")}
      title={copy.title}
      data-assurance={assurance}
    >
      <span aria-hidden="true" className="idf-badge-icon">
        {verified ? (
          <RiShieldCheckLine />
        ) : assurance === "invited" ? (
          <RiMailSendLine />
        ) : (
          <RiQuestionLine />
        )}
      </span>
      {label ?? copy.text}
    </span>
  )
}

export default IdentityBadge
