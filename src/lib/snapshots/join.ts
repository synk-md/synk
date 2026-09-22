/**
 * The joiner snapshot.
 *
 * Yjs queues structs behind a gap in an author's clock sequence. A member added
 * to a non-empty notebook cannot decrypt anything from before their epoch, so
 * every pre-existing author has a gap from their first operation - and *all* of
 * that author's later operations queue behind it. The joiner is not merely
 * missing old content, they are deaf to those authors entirely.
 *
 * A snapshot of current state, sealed under the joiner's epoch key, closes
 * every one of those gaps at once. That is why this is a membership
 * prerequisite rather than a version-history nicety: without it a join to a
 * non-empty notebook does not work at all.
 */

import * as Y from "yjs"
import type { Bytes, SigningKey } from "@/lib/crypto"
import type { DeliveryVector } from "@/lib/sync"
import { createSnapshot, type Snapshot } from "./snapshot"

export interface JoinSnapshotOptions {
  /** The producing member's document, already caught up. */
  doc: Y.Doc
  signingKey: SigningKey
  author: string
  domain: string
  resourceId: string
  /** The epoch cut for the join. The joiner holds this key and no earlier one. */
  epoch: number
  dek: Bytes
  /** Point in the log the producer has reached. */
  covers: DeliveryVector
  parent?: string | null
  createdAt?: number
}

/** Is a snapshot needed at all? An empty notebook has no gaps to close. */
export function needsJoinSnapshot(doc: Y.Doc): boolean {
  return Y.encodeStateVector(doc).length > 1
}

/** Authors with operations in this document, as Yjs client ids. */
export function authorsPresent(doc: Y.Doc): number[] {
  return [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()].sort((a, b) => a - b)
}

/**
 * Produce the snapshot a joiner needs.
 *
 * Sealed under the *new* epoch - the one cut for this join - because that is
 * the only key the joiner holds. Sealing under the previous epoch would leave
 * them exactly as stuck as before.
 */
export async function createJoinSnapshot(options: JoinSnapshotOptions): Promise<Snapshot> {
  return createSnapshot({
    signingKey: options.signingKey,
    author: options.author,
    domain: options.domain,
    resourceId: options.resourceId,
    kind: "join",
    epoch: options.epoch,
    dek: options.dek,
    state: Y.encodeStateAsUpdate(options.doc),
    covers: options.covers,
    parent: options.parent ?? null,
    createdAt: options.createdAt,
  })
}

/**
 * Which pre-existing authors a snapshot re-baselines.
 *
 * The exit criterion is per author, not "current content is visible", so this
 * exists to be checked rather than assumed: every client id present in the
 * snapshot state gets a clean baseline.
 */
export function rebaselinedAuthors(state: Bytes): number[] {
  const probe = new Y.Doc()
  Y.applyUpdate(probe, state)
  return authorsPresent(probe)
}
