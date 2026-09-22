/**
 * Consuming `promotedAtNotebookEpoch`.
 *
 * M5 records where a note left its notebook's timeline but had nothing to do
 * with it, because carrying content across needs a snapshot. This is that
 * consumption.
 *
 * A promoted note's readers hold keys for the note's own domain and none for
 * the notebook. Every envelope written before promotion is sealed under a
 * notebook epoch they cannot open - the same causal deafness a joiner has, for
 * the same reason. The promotion snapshot re-seals current note content under
 * the note's genesis key and records which notebook epoch it supersedes, so a
 * reader knows the notebook history behind it is intentionally unreachable
 * rather than missing.
 */

import * as Y from "yjs"
import type { Bytes, SigningKey } from "@/lib/crypto"
import type { PromoteNoteResult } from "@/lib/keys"
import type { DeliveryVector } from "@/lib/sync"
import { createSnapshot, type Snapshot } from "./snapshot"

export interface PromotionSnapshotOptions {
  /** The note's current content, as materialised under the notebook key. */
  doc: Y.Doc
  signingKey: SigningKey
  author: string
  /** The promotion result from M5, carrying the notebook epoch it left at. */
  promotion: Pick<PromoteNoteResult, "promotedAtNotebookEpoch"> & { domain: string }
  resourceId: string
  /** The note domain's genesis key. */
  dek: Bytes
  covers: DeliveryVector
  createdAt?: number
}

/**
 * Carry a note's content into its own key domain.
 *
 * Always epoch 1 with no parent: the note's domain starts here, and there is no
 * earlier snapshot in it to link to.
 */
export async function createPromotionSnapshot(
  options: PromotionSnapshotOptions,
): Promise<Snapshot> {
  return createSnapshot({
    signingKey: options.signingKey,
    author: options.author,
    domain: options.promotion.domain,
    resourceId: options.resourceId,
    kind: "promotion",
    epoch: 1,
    dek: options.dek,
    state: Y.encodeStateAsUpdate(options.doc),
    covers: options.covers,
    parent: null,
    supersedesNotebookEpoch: options.promotion.promotedAtNotebookEpoch,
    createdAt: options.createdAt,
  })
}

/**
 * Notebook history behind a promotion is unreachable by design, not missing.
 *
 * A reader of a promoted note uses this to tell the two apart, so the interface
 * can say "history before sharing stays in the notebook" rather than presenting
 * an apparent gap.
 */
export function supersededNotebookEpoch(snapshot: Snapshot): number | undefined {
  return snapshot.kind === "promotion" ? snapshot.supersedesNotebookEpoch : undefined
}
