/**
 * Promoting a note to its own key domain, because sharing it outside the
 * notebook cannot mean handing over the notebook DEK.
 *
 * History does not come with it - earlier envelopes are under notebook epochs
 * the recipient cannot open - and promotion is one-way, since demoting would
 * not take back the note keys they already hold.
 */

import type { Bytes, SealingKey } from "@/lib/crypto"
import { KeyDomainAdmin, type KeyRecipient } from "./domain"
import { openKeyring, type SealedEpochKey } from "./keyring"

/** The key domain a note belongs to: its notebook, or itself once promoted. */
export function noteKeyDomain(notebookId: string, noteId: string, promoted: boolean): string {
  return promoted ? notePromotionDomain(noteId) : notebookId
}

export function notePromotionDomain(noteId: string): string {
  return `note:${noteId}`
}

export interface PromoteNoteResult {
  admin: KeyDomainAdmin
  sealed: SealedEpochKey[]
  /** The epoch in the *notebook* domain at which this note stopped using it. */
  promotedAtNotebookEpoch: number
}

/**
 * Give a note its own domain.
 *
 * `members` is everyone who should read it going forward - the notebook members
 * who already could, plus whoever it is being shared with. They are founders of
 * the new domain rather than joiners, because there is no earlier history in it
 * to exclude them from.
 */
export async function promoteNote(
  noteId: string,
  notebook: { domain: string; currentEpoch: number },
  members: readonly KeyRecipient[],
  options: { createdAt?: number; key?: Bytes } = {},
): Promise<PromoteNoteResult> {
  if (members.length === 0) {
    throw new Error("a promoted note must be readable by at least one member")
  }
  const { admin, sealed } = await KeyDomainAdmin.create(
    notePromotionDomain(noteId),
    members,
    options,
  )
  return { admin, sealed, promotedAtNotebookEpoch: notebook.currentEpoch }
}

/**
 * Can this holder read the promoted note? Convenience over the note domain's
 * own keyring - promotion changes which keyring answers, nothing else.
 */
export async function canReadPromotedNote(
  noteId: string,
  sealed: readonly SealedEpochKey[],
  sealingDid: string,
  sealingKey: SealingKey,
): Promise<boolean> {
  const domain = notePromotionDomain(noteId)
  const mine = sealed.filter((copy) => copy?.domain === domain && copy.recipient === sealingDid)
  if (mine.length === 0) return false
  const { anchors } = await openKeyring(mine, domain, sealingDid, sealingKey)
  return anchors.size > 0
}
