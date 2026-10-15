/**
 * Who may sign as an admin.
 *
 * A list of DIDs, or that and the records a former admin signed which the
 * owner kept when it stopped being one - an unlinked device of the owner's.
 * Kept records are named by signature, so nothing that device signs afterwards
 * is honoured, however it is dated.
 */

export interface TrustedAdmins {
  dids: readonly string[]
  /** Signatures by devices no longer admins, which stay valid. */
  kept?: ReadonlySet<string>
}

export type AdminTrust = readonly string[] | TrustedAdmins

function asTrusted(trust: AdminTrust): TrustedAdmins {
  return (trust as TrustedAdmins).dids === undefined ? { dids: trust as readonly string[] } : (trust as TrustedAdmins)
}

/** Checked before the signature, which must still verify under `admin`. */
export function trustsAdmin(trust: AdminTrust, admin: string, sig: string): boolean {
  const { dids, kept } = asTrusted(trust)
  return dids.includes(admin) || (kept?.has(sig) ?? false)
}

export function adminDidsOf(trust: AdminTrust): readonly string[] {
  return asTrusted(trust).dids
}

export function keptOf(trust: AdminTrust): ReadonlySet<string> {
  return asTrusted(trust).kept ?? new Set()
}
