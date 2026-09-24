/**
 * Snapshotting every note when somebody joins.
 *
 * A member added to a non-empty document cannot place any pre-existing author's
 * operations: a gap in an author's clock sequence blocks all of their later
 * work, and the envelopes that would fill it are sealed under epochs the joiner
 * cannot open. Without a snapshot they decrypt new edits and see none of them
 * land.
 *
 * The awkward part is that the key domain is per **notebook** while a snapshot
 * is per **document**, and a notebook is many notes. So admission snapshots
 * them all, sealed under the new epoch, and the cost is borne by the admitting
 * admin at grant time.
 *
 * That cost is real - a two hundred note notebook means two hundred opens and
 * two hundred seal-and-sign operations - and it is the right place to pay it.
 * The alternatives all need a member online at an unpredictable later moment,
 * which is the thing this design exists to avoid.
 *
 * A note with no operations is skipped. The failure a snapshot prevents is a
 * clock gap belonging to a pre-existing author, and a document nobody has
 * written to has no authors and therefore no gaps.
 */

import * as Y from "yjs"

import type { Bytes, SigningKey } from "@/lib/crypto"
import { createSnapshot, type Snapshot } from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"

import { keyDomainFor } from "./notebook-keys"
import { noteResourceId } from "./note-sync"

export interface NoteSource {
  noteId: string
  doc: Y.Doc
  /** What the snapshot covers. Empty until envelopes carry the notes. */
  covers?: DeliveryVector
}

export interface JoinSnapshotOptions {
  notebookId: string
  notes: readonly NoteSource[]
  /** The epoch cut for this join. The joiner holds its key and nothing earlier. */
  epoch: number
  dek: Bytes
  signingKey: SigningKey
  author: string
  createdAt?: number
}

/** True when nobody has written to this document, so it has no author gaps. */
export function hasNoOperations(doc: Y.Doc): boolean {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).size === 0
}

/**
 * One snapshot per note that needs one, under the joining epoch.
 *
 * Notes with no operations are skipped and reported, rather than snapshotted
 * for symmetry: there is no author whose later work could be blocked, so the
 * snapshot would close a gap that cannot exist.
 */
export interface JoinSnapshotResult {
  /** Each carries the wrap that makes it openable under the joining epoch. */
  snapshots: Snapshot[]
  /** Note ids that needed none. Reported so a caller can show the real count. */
  skipped: string[]
}

export async function snapshotNotesForJoiner(
  options: JoinSnapshotOptions,
): Promise<JoinSnapshotResult> {
  const domain = keyDomainFor(options.notebookId)
  const createdAt = options.createdAt ?? Date.now()

  const snapshots: Snapshot[] = []
  const skipped: string[] = []
  for (const note of options.notes) {
    if (hasNoOperations(note.doc)) {
      skipped.push(note.noteId)
      continue
    }
    const created = await createSnapshot({
        signingKey: options.signingKey,
        author: options.author,
        domain,
        resourceId: noteResourceId(options.notebookId, note.noteId),
        kind: "join",
        epoch: options.epoch,
        dek: options.dek,
        state: Y.encodeStateAsUpdate(note.doc),
      covers: note.covers ?? {},
      parent: null,
      createdAt,
    })
    snapshots.push(created)
  }
  return { snapshots, skipped }
}

/**
 * Snapshots for one note, newest last.
 *
 * A joiner applies the newest it can open; the others are the chain behind it.
 */
export function snapshotsForNote(
  snapshots: readonly Snapshot[],
  notebookId: string,
  noteId: string,
): Snapshot[] {
  const resource = noteResourceId(notebookId, noteId)
  return snapshots
    .filter((snapshot) => snapshot.resourceId === resource)
    .sort((a, b) => a.createdAt - b.createdAt)
}
