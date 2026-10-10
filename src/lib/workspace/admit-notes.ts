/**
 * Making a new member able to read a notebook that already has content.
 *
 * Granting membership is one record. Making it *usable* touches every note:
 * without a baseline under the joining epoch, a new member decrypts incoming
 * edits and can place none of them, because a gap in an existing author's clock
 * sequence blocks everything that author writes afterwards.
 *
 * Three outcomes per note, cheapest first:
 *
 *   skip     no operations, so no author gap can exist
 *   rewrap   a snapshot already covers the note's current state, so only its
 *            content key is re-sealed - no open, no re-encryption
 *   build    anything else: materialise, seal under the joining epoch, sign
 *
 * The rewrap path is why this is affordable on a notebook where most notes are
 * dormant. The qualifying check is metadata on both sides, so notes are sorted
 * into the three buckets without opening any of them.
 */

import * as Y from "yjs"

import type { Bytes, SigningKey } from "@/lib/crypto"
import {
  coversCurrentState,
  rewrapSnapshot,
  type Snapshot,
} from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"

import {
  completeTask,
  planAdmission,
  progressOf,
  runAdmissionPlan,
  type AdmissionPlan,
  type NoteRef,
  type NoteTask,
  type PlanProgress,
} from "./admission-plan"
import { keyDomainFor } from "./notebook-keys"
import { hasNoOperations, snapshotNotesForJoiner } from "./note-snapshots"
import { noteResourceId } from "./note-sync"

export type NoteOutcome = "skipped" | "rewrapped" | "built"

export interface NoteAdmissionOptions {
  notebookId: string
  /** `did:key` of the device being admitted. Identifies the plan to resume. */
  joiner: string
  /** The epoch cut for this join, per key domain. */
  epochs: Record<string, number>
  /** The notes to cover. Promoted ones name their own domain. */
  notes: readonly NoteRef[]
  /** Loads a note's document. The expensive part, and why this is resumable. */
  loadNote: (noteId: string) => Promise<Y.Doc>
  /** Epoch keys this admin holds, for sealing and for rewrapping. */
  keyFor: (domain: string, epoch: number) => Promise<Bytes | undefined>
  signingKey: SigningKey
  author: string
  /** Snapshots already in the archive, consulted before building a new one. */
  existing?: readonly Snapshot[]
  /** Where a note currently stands, for the rewrap check. Metadata only. */
  coversFor?: (noteId: string) => DeliveryVector
  deposit: (snapshot: Snapshot) => Promise<void>
  onProgress?: (progress: PlanProgress, task: NoteTask, outcome?: NoteOutcome) => void
  signal?: AbortSignal
  now?: number
}

export interface NoteAdmissionResult {
  plan: AdmissionPlan
  skipped: string[]
  rewrapped: string[]
  built: string[]
}

/**
 * The newest snapshot for a note that already covers its current state.
 *
 * Exact equality only. A snapshot lagging one operation leaves a gap for that
 * operation's author, which is the deafness this whole routine exists to
 * prevent, so "nearly current" is not a state a note can be in here.
 */
function reusable(
  snapshots: readonly Snapshot[],
  resourceId: string,
  current: DeliveryVector,
): Snapshot | undefined {
  return snapshots
    .filter((snapshot) => snapshot.resourceId === resourceId)
    .filter((snapshot) => coversCurrentState(snapshot, current))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * Cover every note for a joiner, resumably.
 *
 * Each note is recorded the moment it lands, so a tab closed halfway leaves a
 * plan that finishes rather than a member deaf to whatever was left.
 */
export async function runNoteAdmission(
  options: NoteAdmissionOptions,
): Promise<NoteAdmissionResult> {
  const now = options.now ?? Date.now()
  const skipped: string[] = []
  const rewrapped: string[] = []
  const built: string[] = []

  const plan = planAdmission({
    notebookId: options.notebookId,
    joiner: options.joiner,
    notes: options.notes,
    epochs: options.epochs,
    startedAt: now,
  })

  const finished = await runAdmissionPlan({
    plan,
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (progress, task) => {
      options.onProgress?.(progress, task)
    },
    snapshot: async (task) => {
      const epoch = options.epochs[task.domain]
      if (epoch === undefined) {
        throw new Error(`no joining epoch for domain ${task.domain}`)
      }
      const resourceId = noteResourceId(options.notebookId, task.noteId)

      // Rewrap first, because it is the only branch that avoids opening the
      // document at all - and on a mature notebook it is most of them.
      const current = options.coversFor?.(task.noteId) ?? {}
      const candidate = reusable(options.existing ?? [], resourceId, current)
      if (candidate) {
        const fromWrap = candidate.wraps.find((wrap) => wrap.epoch !== epoch)
        const fromKey = fromWrap ? await options.keyFor(task.domain, fromWrap.epoch) : undefined
        const toKey = await options.keyFor(task.domain, epoch)
        if (fromWrap && fromKey && toKey) {
          await options.deposit(
            await rewrapSnapshot(candidate, {
              fromEpochKey: fromKey,
              toEpoch: epoch,
              toEpochKey: toKey,
              signingKey: options.signingKey,
              wrapper: options.author,
              createdAt: now,
            }),
          )
          rewrapped.push(task.noteId)
          options.onProgress?.(progressOf(plan), task, "rewrapped")
          return true
        }
        // Falls through to a fresh snapshot rather than failing: a missing key
        // for the older epoch is a reason to rebuild, not to leave a gap.
      }

      const doc = await options.loadNote(task.noteId)
      if (hasNoOperations(doc)) {
        skipped.push(task.noteId)
        options.onProgress?.(progressOf(plan), task, "skipped")
        return false
      }

      const dek = await options.keyFor(task.domain, epoch)
      if (!dek) throw new Error(`no key for epoch ${String(epoch)} of ${task.domain}`)

      const { snapshots } = await snapshotNotesForJoiner({
        notebookId: options.notebookId,
        notes: [{ noteId: task.noteId, covers: current, doc }],
        epoch,
        dek,
        signingKey: options.signingKey,
        author: options.author,
        createdAt: now,
      })
      for (const snapshot of snapshots) await options.deposit(snapshot)
      built.push(task.noteId)
      options.onProgress?.(progressOf(plan), task, "built")
      return true
    },
  })

  return { plan: finished, skipped, rewrapped, built }
}

/** Notes under the notebook's own key, plus any that were promoted. */
export function noteRefsFor(
  notebookId: string,
  noteIds: readonly string[],
  promoted: ReadonlySet<string> = new Set(),
): NoteRef[] {
  return noteIds.map((noteId) =>
    promoted.has(noteId)
      ? { noteId, domain: `${keyDomainFor(notebookId)}/note:${noteId}` }
      : { noteId },
  )
}

/** Mark a note covered without doing the work, for a caller that already did. */
export function markCovered(plan: AdmissionPlan, noteId: string): AdmissionPlan {
  return completeTask(plan, noteId, "done")
}
