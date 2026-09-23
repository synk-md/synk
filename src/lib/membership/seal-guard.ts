/**
 * Refuse to seal from a stale keyring view.
 *
 * M5 found that a keyring view is a snapshot of shared state, and shared state
 * moves - every membership change cuts an epoch. A member whose view is behind
 * keeps sealing under a superseded epoch, producing content that recent joiners
 * cannot read. That is a correctness requirement, not an optimisation, and M5
 * could only document it.
 *
 * Here it is enforced. A sealing path proves its view is current against the
 * authoritative (signed) timeline before it seals, so a stale writer fails loudly
 * instead of silently stranding whoever joins next.
 */

import type { EpochTimeline } from "@/lib/keys"
import type { ReadKeySource } from "@/lib/keys"

export interface CurrencyCheck {
  current: boolean
  viewEpoch: number
  authoritativeEpoch: number
}

export function checkKeyringCurrency(
  view: Pick<ReadKeySource, "domain" | "currentEpoch">,
  timeline: EpochTimeline,
): CurrencyCheck {
  return {
    current: view.currentEpoch >= timeline.length,
    viewEpoch: view.currentEpoch,
    authoritativeEpoch: timeline.length,
  }
}

/**
 * Gate a seal on a current view.
 *
 * Throws rather than returning a flag: there is no sensible way to continue, and
 * the failure names both epochs so the caller knows how far behind it is.
 */
export function assertKeyringCurrent(
  view: Pick<ReadKeySource, "domain" | "currentEpoch">,
  timeline: EpochTimeline,
): void {
  if (timeline.length > 0 && view.domain !== timeline[0].domain) {
    throw new Error(
      `keyring for ${view.domain} cannot be checked against a timeline for ${timeline[0].domain}`,
    )
  }
  const check = checkKeyringCurrency(view, timeline)
  if (!check.current) {
    throw new Error(
      `refusing to seal ${view.domain} from a keyring at epoch ${String(check.viewEpoch)} ` +
        `when the signed timeline is at ${String(check.authoritativeEpoch)}: ` +
        `sealing under a superseded epoch would strand recent joiners. Refresh first.`,
    )
  }
}

/**
 * The recipient's own latest epoch, when known.
 *
 * Sealing to someone must not happen from a view behind *their* latest either -
 * that is the case where the seal looks fine to the sealer and is useless to the
 * recipient.
 */
export function assertCoversRecipient(
  view: Pick<ReadKeySource, "domain" | "currentEpoch">,
  recipientLatestEpoch: number,
): void {
  if (view.currentEpoch < recipientLatestEpoch) {
    throw new Error(
      `refusing to seal ${view.domain} from a keyring at epoch ${String(view.currentEpoch)} ` +
        `for a recipient already at ${String(recipientLatestEpoch)}`,
    )
  }
}
