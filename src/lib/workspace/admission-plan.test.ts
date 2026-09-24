import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearPlan,
  completeTask,
  domainsOf,
  isComplete,
  loadPlan,
  pendingTasks,
  planAdmission,
  progressOf,
  runAdmissionPlan,
  unreadableNotes,
} from "./admission-plan"
import { keyDomainFor } from "./notebook-keys"

const NOTEBOOK = "travel"
const JOINER = "did:key:zAda"
const DOMAIN = keyDomainFor(NOTEBOOK)
const EPOCHS = { [DOMAIN]: 2 }

beforeEach(() => {
  localStorage.clear()
})

function aPlan(notes = ["a", "b", "c"], epochs: Record<string, number> = EPOCHS) {
  return planAdmission({
    notebookId: NOTEBOOK,
    joiner: JOINER,
    notes: notes.map((noteId) => ({ noteId })),
    epochs,
    startedAt: 1,
  })
}

describe("planning an admission", () => {
  it("starts every note pending, under the notebook's domain", () => {
    const plan = aPlan()

    expect(plan.tasks).toHaveLength(3)
    expect(plan.tasks.every((task) => task.state === "pending")).toBe(true)
    expect(domainsOf(plan)).toEqual([DOMAIN])
  })

  /** A promoted note has its own timeline, so its key and snapshot are its own. */
  it("carries an epoch per domain, so a promoted note gets its own", () => {
    const promoted = "notebook:travel/note:kyoto"
    const plan = planAdmission({
      notebookId: NOTEBOOK,
      joiner: JOINER,
      notes: [{ noteId: "a" }, { noteId: "kyoto", domain: promoted }],
      epochs: { [DOMAIN]: 2, [promoted]: 5 },
      startedAt: 1,
    })

    expect(domainsOf(plan)).toEqual([DOMAIN, promoted].sort())
    expect(plan.epochs[promoted]).toBe(5)
  })
})

describe("resuming", () => {
  /** A tab closed halfway must not leave a member deaf to the rest. */
  it("keeps finished notes finished and retries the rest", () => {
    const started = aPlan()
    completeTask(completeTask(started, "a", "done"), "b", "failed", "storage went away")

    const resumed = aPlan()

    expect(resumed.tasks.find((t) => t.noteId === "a")?.state).toBe("done")
    // A failed note goes back to pending rather than being abandoned.
    expect(resumed.tasks.find((t) => t.noteId === "b")?.state).toBe("pending")
    expect(pendingTasks(resumed).map((t) => t.noteId)).toEqual(["b", "c"])
  })

  it("survives a reload, because state is written as it goes", () => {
    completeTask(aPlan(), "a", "done")

    const fromStorage = loadPlan(NOTEBOOK, JOINER)
    expect(fromStorage?.tasks.find((t) => t.noteId === "a")?.state).toBe("done")
  })

  /** Different epochs mean a different admission, not a continuation of this one. */
  it("discards a plan for different epochs rather than half-applying it", () => {
    completeTask(aPlan(), "a", "done")

    const different = aPlan(["a", "b", "c"], { [DOMAIN]: 9 })

    expect(different.tasks.every((task) => task.state === "pending")).toBe(true)
  })

  it("picks up notes added since the plan started", () => {
    completeTask(aPlan(["a"]), "a", "done")

    const wider = aPlan(["a", "b"])

    expect(wider.tasks.find((t) => t.noteId === "a")?.state).toBe("done")
    expect(pendingTasks(wider).map((t) => t.noteId)).toEqual(["b"])
  })
})

describe("running a plan", () => {
  it("records each note as it lands, not at the end", async () => {
    const plan = aPlan()
    const seen: string[] = []

    await runAdmissionPlan({
      plan,
      snapshot: (task) => {
        // Whatever has already been recorded is durable by now.
        seen.push(loadPlan(NOTEBOOK, JOINER)?.tasks.filter((t) => t.state === "done").length
          ? `after:${task.noteId}`
          : `first:${task.noteId}`)
        return Promise.resolve(true)
      },
    })

    expect(seen[0]).toBe("first:a")
    expect(seen[1]).toBe("after:b")
  })

  it("marks an empty note skipped rather than snapshotting it", async () => {
    const plan = await runAdmissionPlan({
      plan: aPlan(["empty", "written"]),
      snapshot: (task) => Promise.resolve(task.noteId !== "empty"),
    })

    expect(plan.tasks.find((t) => t.noteId === "empty")?.state).toBe("skipped-empty")
    expect(plan.tasks.find((t) => t.noteId === "written")?.state).toBe("done")
    expect(isComplete(plan)).toBe(true)
    expect(progressOf(plan)).toMatchObject({ total: 2, done: 1, skipped: 1, remaining: 0 })
  })

  /** One note failing must not abandon the rest. */
  it("carries on past a failure and leaves it retryable", async () => {
    const plan = await runAdmissionPlan({
      plan: aPlan(),
      snapshot: (task) => {
        if (task.noteId === "b") throw new Error("could not open b")
        return Promise.resolve(true)
      },
    })

    expect(plan.tasks.find((t) => t.noteId === "b")?.state).toBe("failed")
    expect(plan.tasks.find((t) => t.noteId === "b")?.error).toBe("could not open b")
    expect(plan.tasks.find((t) => t.noteId === "c")?.state).toBe("done")
    expect(isComplete(plan)).toBe(false)
    expect(unreadableNotes(plan)).toEqual(["b"])
  })

  it("finishes on a second run, and does not redo what landed", async () => {
    const attempted: string[] = []
    const failing = (task: { noteId: string }) => {
      attempted.push(task.noteId)
      if (task.noteId === "b" && attempted.filter((n) => n === "b").length === 1) {
        throw new Error("transient")
      }
      return Promise.resolve(true)
    }

    let plan = await runAdmissionPlan({ plan: aPlan(), snapshot: failing })
    expect(isComplete(plan)).toBe(false)

    plan = await runAdmissionPlan({ plan: planAdmission({
      notebookId: NOTEBOOK,
      joiner: JOINER,
      notes: [{ noteId: "a" }, { noteId: "b" }, { noteId: "c" }],
      epochs: EPOCHS,
    }), snapshot: failing })

    expect(isComplete(plan)).toBe(true)
    // "a" and "c" were done the first time and never reattempted.
    expect(attempted.filter((n) => n === "a")).toHaveLength(1)
    expect(attempted.filter((n) => n === "c")).toHaveLength(1)
  })

  it("stops cleanly when abandoned", async () => {
    const controller = new AbortController()
    const snapshot = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve(true)
    })

    const plan = await runAdmissionPlan({
      plan: aPlan(),
      snapshot,
      signal: controller.signal,
    })

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(isComplete(plan)).toBe(false)
  })

  it("reports progress as it goes", async () => {
    const seen: number[] = []
    await runAdmissionPlan({
      plan: aPlan(),
      snapshot: () => Promise.resolve(true),
      onProgress: (progress) => seen.push(progress.done),
    })

    expect(seen).toEqual([1, 2, 3])
  })
})

describe("finishing", () => {
  it("is cleared once there is nothing outstanding", async () => {
    const plan = await runAdmissionPlan({
      plan: aPlan(),
      snapshot: () => Promise.resolve(true),
    })
    expect(isComplete(plan)).toBe(true)

    clearPlan(NOTEBOOK, JOINER)
    expect(loadPlan(NOTEBOOK, JOINER)).toBeNull()
  })
})
