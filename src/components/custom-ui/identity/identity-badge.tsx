"use client"

import { RiShieldCheckLine, RiMailSendLine, RiQuestionLine } from "@remixicon/react"

import "./identity.scss"

/**
 * How much a displayed name is actually worth.
 *
 * The three levels are not decoration. They are the difference between a name
 * someone typed about themselves, a name an admin intended for someone, and a
 * name whose key has actually been checked:
 *
 *   self-asserted  the subject chose this. Proves nothing - an attacker
 *                  redeeming a leaked invitation would choose it too.
 *   invited        an admin wrote it on the invitation. Says who the admin
 *                  *meant* to invite, not who turned up holding the secret.
 *   verified       someone compared the key fingerprint out of band. This is
 *                  the only level that ties the name to a key.
 *
 * `invited` is the one that misleads if unlabelled, because the name came from
 * a trusted person - just not about the party in front of you.
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

/**
 * Anything short of `verified` reads as "Unverified" on purpose. A person
 * scanning a list should not have to work out that "invited" is weaker than
 * "verified"; the two unverified levels differ only in the explanation.
 */
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
