/**
 * The three deletion operations.
 *
 *   notebook   destroy the whole key domain. The retained ciphertext stays
 *              wherever it is and becomes noise.
 *   history    destroy epochs up to a point, keeping current content via a
 *              snapshot under a surviving epoch.
 *   note       the same as a notebook erasure, on a promoted note's own domain.
 *
 * All three are cryptographic: nothing is overwritten and nothing is chased
 * across the network. What changes is that the keys are gone, which is the only
 * deletion primitive that means anything when the bytes are on someone else's
 * disk.
 */

import type { SigningKey } from "@/lib/crypto"
import type { FlatKeyring } from "@/lib/keys"
import { notePromotionDomain } from "@/lib/keys"
import type { Envelope } from "@/lib/sync"
import type { SnapshotEntry } from "@/lib/snapshots"

import { assessErasure, requirePreservation, type ErasureImpact } from "./impact"
import { prefixTargets } from "./scope"
import { orderErasure, type ErasureRecord } from "./tombstone"

export interface CiphertextRequest {
  envelopes: { author: string; seq: number }[]
  snapshots: string[]
}

export interface ErasureOutcome {
  record: ErasureRecord
  impact: ErasureImpact
  /** Epochs this device destroyed. Persist these, or a reload undoes it. */
  destroyed: number[]
  /**
   * What to ask the relay to drop. Best effort and not the guarantee - the
   * ciphertext is already noise. Asking reduces exposure; it does not create
   * the property.
   */
  ciphertext: CiphertextRequest
}

export interface EraseOptions {
  keyring: FlatKeyring
  resourceId: string
  admin: { signingKey: SigningKey; did: string }
  envelopes?: readonly Pick<Envelope, "author" | "seq" | "epoch">[]
  snapshots?: readonly SnapshotEntry[]
  reason?: string
  now?: number
}

function ciphertextFor(
  epochs: ReadonlySet<number>,
  envelopes: readonly Pick<Envelope, "author" | "seq" | "epoch">[],
  snapshots: readonly SnapshotEntry[],
): CiphertextRequest {
  return {
    envelopes: envelopes
      .filter((envelope) => epochs.has(envelope.epoch))
      .map((envelope) => ({ author: envelope.author, seq: envelope.seq })),
    snapshots: snapshots.filter((entry) => epochs.has(entry.epoch)).map((entry) => entry.id),
  }
}

/**
 * Delete a notebook: every epoch of its domain.
 *
 * No preservation check, because leaving nothing readable is the intent rather
 * than an accident. `impact.contentLost` will be true and that is the success
 * condition.
 */
export async function eraseDomain(options: EraseOptions): Promise<ErasureOutcome> {
  const timeline = options.keyring.timeline
  const targets = prefixTargets(timeline.length)

  const impact = assessErasure({
    timeline,
    heldAnchors: options.keyring.anchorEpochs,
    targets,
    ...(options.envelopes ? { envelopes: options.envelopes } : {}),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
  })

  const record = await orderErasure({
    signingKey: options.admin.signingKey,
    issuer: options.admin.did,
    domain: options.keyring.domain,
    resourceId: options.resourceId,
    scope: "domain",
    throughEpoch: timeline.length,
    preservedBy: null,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.now === undefined ? {} : { issuedAt: options.now }),
  })

  options.keyring.forget(impact.scope.epochs)

  return {
    record,
    impact,
    destroyed: options.keyring.destroyedEpochs,
    ciphertext: ciphertextFor(
      new Set(impact.scope.epochs),
      options.envelopes ?? [],
      options.snapshots ?? [],
    ),
  }
}

export interface EraseHistoryOptions extends EraseOptions {
  /** Highest epoch to destroy. Everything at or below it goes. */
  throughEpoch: number
  /**
   * Proceed even though nothing readable would survive. Never defaulted on -
   * a history purge that silently deletes the document is the failure this
   * whole module exists to prevent.
   */
  allowContentLoss?: boolean
}

/**
 * Purge history before a point, keeping the document.
 *
 * A prefix is the shape that is always clean: no anchor survives that reaches
 * back into it, so nothing is lost beyond what was asked for.
 */
export async function eraseHistory(options: EraseHistoryOptions): Promise<ErasureOutcome> {
  const timeline = options.keyring.timeline
  if (options.throughEpoch >= timeline.length) {
    throw new Error(
      `refusing to purge through epoch ${String(options.throughEpoch)}: that is the current epoch, which would be a notebook deletion`,
    )
  }

  const impact = assessErasure({
    timeline,
    heldAnchors: options.keyring.anchorEpochs,
    targets: prefixTargets(options.throughEpoch),
    ...(options.envelopes ? { envelopes: options.envelopes } : {}),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
  })

  if (!options.allowContentLoss) requirePreservation(impact)

  const record = await orderErasure({
    signingKey: options.admin.signingKey,
    issuer: options.admin.did,
    domain: options.keyring.domain,
    resourceId: options.resourceId,
    scope: "history",
    throughEpoch: options.throughEpoch,
    preservedBy: impact.preservedBy,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.now === undefined ? {} : { issuedAt: options.now }),
  })

  options.keyring.forget(impact.scope.epochs)

  return {
    record,
    impact,
    destroyed: options.keyring.destroyedEpochs,
    ciphertext: ciphertextFor(
      new Set(impact.scope.epochs),
      options.envelopes ?? [],
      options.snapshots ?? [],
    ),
  }
}

export interface NoteErasability {
  erasable: boolean
  /** The note's own key domain, when it has one. */
  domain: string | null
  /**
   * Content written before this epoch of the *notebook* is not covered. Null
   * when the note has always had its own domain.
   */
  horizon: number | null
  reason: string
  remedy: string | null
}

/**
 * Whether a note can be erased on its own.
 *
 * It can only if it was promoted to its own key domain. An unpromoted note is
 * sealed under the notebook's epoch keys, the same ones every other note uses,
 * so there is no key that unlocks this note and nothing else - erasing it would
 * mean erasing the notebook.
 *
 * And promotion is not retroactive. Content written before the promotion stays
 * under notebook epochs, so surgical erasure has a horizon: from the promotion
 * forward. Earlier content goes only with a notebook history purge.
 */
export function noteErasability(options: {
  noteId: string
  promoted: boolean
  /** Notebook epoch at which the note was promoted, when it was. */
  promotedAtEpoch?: number
}): NoteErasability {
  if (!options.promoted) {
    return {
      erasable: false,
      domain: null,
      horizon: null,
      reason:
        "this note is sealed under the notebook's keys, which every other note also uses, so there is no key that unlocks only this note",
      remedy:
        "give the note its own key first. From then on it can be erased on its own; anything written before that goes only with a notebook history purge.",
    }
  }

  return {
    erasable: true,
    domain: notePromotionDomain(options.noteId),
    horizon: options.promotedAtEpoch ?? null,
    reason: "this note has its own key domain, so its keys can be destroyed alone",
    remedy:
      options.promotedAtEpoch === undefined
        ? null
        : `content written before notebook epoch ${String(options.promotedAtEpoch)} stays under the notebook's keys and is not covered`,
  }
}

/**
 * Erase a promoted note. Refuses an unpromoted one rather than erasing more
 * than was asked for.
 */
export async function eraseNote(
  options: EraseOptions & { noteId: string; promoted: boolean; promotedAtEpoch?: number },
): Promise<ErasureOutcome & { horizon: number | null }> {
  const erasability = noteErasability({
    noteId: options.noteId,
    promoted: options.promoted,
    ...(options.promotedAtEpoch === undefined ? {} : { promotedAtEpoch: options.promotedAtEpoch }),
  })
  if (!erasability.erasable) throw new Error(erasability.reason)

  if (options.keyring.domain !== erasability.domain) {
    throw new Error(
      `keyring is for ${options.keyring.domain}, not the note's own domain ${String(erasability.domain)}`,
    )
  }

  const outcome = await eraseDomain(options)
  return { ...outcome, horizon: erasability.horizon }
}

/**
 * Honour someone else's erasure order.
 *
 * The verification is the caller's - this only acts. It destroys what the order
 * names, and destroys it from this holder's anchors, which may be a different
 * set from the issuer's.
 */
export function applyErasure(keyring: FlatKeyring, record: ErasureRecord): number[] {
  if (record.domain !== keyring.domain) return []
  const impact = assessErasure({
    timeline: keyring.timeline,
    heldAnchors: keyring.anchorEpochs,
    targets: prefixTargets(record.throughEpoch),
  })
  keyring.forget(impact.scope.epochs)
  return impact.scope.epochs
}
