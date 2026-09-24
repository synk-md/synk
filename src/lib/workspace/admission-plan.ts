/**
 * Admission across many documents, made resumable.
 *
 * Granting membership writes one record; making the joiner able to *read*
 * touches every note in the notebook, and a notebook is not a small number of
 * documents. Two hundred opens, decrypts, seals and signatures is not something
 * that fits in one transaction, and a browser tab that is closed halfway
 * through must not leave a member who can see some notes and is deaf to the
 * rest.
 *
 * So the work is a plan with per-note state, persisted as it goes. Re-running
 * it finishes what is outstanding and touches nothing already done. A crash is
 * a pause.
 *
 * ## Promoted notes are their own key domains
 *
 * A note promoted out of its notebook has its own epoch timeline, so its key
 * must be sealed to the joiner separately and its snapshot sealed under *its*
 * epoch. The plan therefore carries an epoch per domain rather than one for the
 * notebook, and a task names the domain it belongs to.
 */

import type * as Y from "yjs"

import { keyDomainFor } from "./notebook-keys"

const KEY = "synk:admission-plans:v1"

export type NoteTaskState =
  /** Not started, or interrupted before it landed. */
  | "pending"
  /** No operations, so no author gaps to close. Nothing to do. */
  | "skipped-empty"
  /** A snapshot exists for the joining epoch. */
  | "done"
  /** Tried and failed. Retried on the next run rather than abandoned. */
  | "failed"

export interface NoteTask {
  noteId: string
  /** The notebook's domain, or the note's own once promoted. */
  domain: string
  state: NoteTaskState
  /** Set when the last attempt failed, so a stuck note is visible. */
  error?: string
  attempts: number
}

export interface AdmissionPlan {
  notebookId: string
  /** `did:key` of the device being admitted. One plan per joiner. */
  joiner: string
  /** The joining epoch for each domain touched. */
  epochs: Record<string, number>
  tasks: NoteTask[]
  startedAt: number
}

export interface NoteRef {
  noteId: string
  /** Omit for a note under the notebook's own key. */
  domain?: string
}

function planId(notebookId: string, joiner: string): string {
  return `${notebookId}|${joiner}`
}

function readAll(): Record<string, AdmissionPlan> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, AdmissionPlan>) : {}
  } catch {
    return {}
  }
}

function writeAll(plans: Record<string, AdmissionPlan>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(plans))
  } catch {
    // Losing the plan costs a redo, not correctness: every step is idempotent.
  }
}

export function loadPlan(notebookId: string, joiner: string): AdmissionPlan | null {
  return readAll()[planId(notebookId, joiner)] ?? null
}

export function savePlan(plan: AdmissionPlan): void {
  const all = readAll()
  all[planId(plan.notebookId, plan.joiner)] = plan
  writeAll(all)
}

export function clearPlan(notebookId: string, joiner: string): void {
  const all = readAll()
  const id = planId(notebookId, joiner)
  if (!(id in all)) return
  const rest = { ...all }
  delete rest[id]
  writeAll(rest)
}

export interface PlanOptions {
  notebookId: string
  joiner: string
  notes: readonly NoteRef[]
  /** Joining epoch per domain. The notebook's domain must be present. */
  epochs: Record<string, number>
  startedAt?: number
}

/**
 * Start a plan, or pick up the one already in progress.
 *
 * Resuming is keyed on the joiner and the epochs: a plan for the same person at
 * the same epochs is the same work, and its finished tasks stand. Different
 * epochs mean a different admission, so the old plan is discarded rather than
 * half-applied to a new one.
 */
export function planAdmission(options: PlanOptions): AdmissionPlan {
  const existing = loadPlan(options.notebookId, options.joiner)
  const sameEpochs =
    existing !== null &&
    JSON.stringify(existing.epochs) === JSON.stringify(options.epochs)

  const done = new Map<string, NoteTask>(
    sameEpochs ? existing.tasks.map((task) => [task.noteId, task]) : [],
  )

  const tasks = options.notes.map((note): NoteTask => {
    const domain = note.domain ?? keyDomainFor(options.notebookId)
    const previous = done.get(note.noteId)
    // A finished task stays finished; a failed one goes back to pending so the
    // next run retries it rather than skipping it forever.
    if (previous && (previous.state === "done" || previous.state === "skipped-empty")) {
      return { ...previous, domain }
    }
    return {
      noteId: note.noteId,
      domain,
      state: "pending",
      attempts: previous?.attempts ?? 0,
    }
  })

  const plan: AdmissionPlan = {
    notebookId: options.notebookId,
    joiner: options.joiner,
    epochs: { ...options.epochs },
    tasks,
    startedAt: sameEpochs ? existing.startedAt : (options.startedAt ?? Date.now()),
  }
  savePlan(plan)
  return plan
}

export function pendingTasks(plan: AdmissionPlan): NoteTask[] {
  return plan.tasks.filter((task) => task.state === "pending" || task.state === "failed")
}

export function isComplete(plan: AdmissionPlan): boolean {
  return pendingTasks(plan).length === 0
}

export interface PlanProgress {
  total: number
  done: number
  skipped: number
  failed: number
  remaining: number
}

export function progressOf(plan: AdmissionPlan): PlanProgress {
  const count = (state: NoteTaskState) =>
    plan.tasks.filter((task) => task.state === state).length
  const done = count("done")
  const skipped = count("skipped-empty")
  const failed = count("failed")
  return {
    total: plan.tasks.length,
    done,
    skipped,
    failed,
    remaining: plan.tasks.length - done - skipped,
  }
}

/** Record an outcome and persist immediately, so a crash loses at most one note. */
export function completeTask(
  plan: AdmissionPlan,
  noteId: string,
  state: NoteTaskState,
  error?: string,
): AdmissionPlan {
  const next: AdmissionPlan = {
    ...plan,
    tasks: plan.tasks.map((task) =>
      task.noteId === noteId
        ? {
            ...task,
            state,
            attempts: task.attempts + 1,
            ...(error === undefined ? {} : { error }),
          }
        : task,
    ),
  }
  savePlan(next)
  return next
}

export interface RunOptions {
  plan: AdmissionPlan
  /**
   * Produce the snapshot for one note. Resolving `false` means the note had no
   * operations; anything thrown leaves the task failed and retryable.
   */
  snapshot: (task: NoteTask) => Promise<boolean>
  onProgress?: (progress: PlanProgress, task: NoteTask) => void
  /** Checked between notes so a long run can be abandoned cleanly. */
  signal?: AbortSignal
}

/**
 * Work through what is outstanding.
 *
 * One note at a time and persisted after each, deliberately. Batching would be
 * faster and would widen the window in which a crash loses work, which is the
 * thing the plan exists to bound.
 */
export async function runAdmissionPlan(options: RunOptions): Promise<AdmissionPlan> {
  let plan = options.plan

  for (const task of pendingTasks(plan)) {
    if (options.signal?.aborted) break
    try {
      const produced = await options.snapshot(task)
      plan = completeTask(plan, task.noteId, produced ? "done" : "skipped-empty")
    } catch (error) {
      plan = completeTask(
        plan,
        task.noteId,
        "failed",
        error instanceof Error ? error.message : "snapshot failed",
      )
    }
    options.onProgress?.(progressOf(plan), task)
  }

  return plan
}

/** Notes still deaf to pre-existing authors, for a caller that wants to say so. */
export function unreadableNotes(plan: AdmissionPlan): string[] {
  return pendingTasks(plan).map((task) => task.noteId)
}

/** Every key domain this admission has to seal into. */
export function domainsOf(plan: AdmissionPlan): string[] {
  return [...new Set(plan.tasks.map((task) => task.domain))].sort()
}

/** The Yjs documents a plan still needs materialised. */
export function notesNeedingMaterialisation(plan: AdmissionPlan): string[] {
  return pendingTasks(plan).map((task) => task.noteId)
}

export type NoteLoader = (noteId: string) => Promise<Y.Doc>
