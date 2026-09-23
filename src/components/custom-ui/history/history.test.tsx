import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createUser, type User } from "@/lib/identity"
import { buildTimeline, type RestorePlan, type RestorePoint } from "@/lib/history"
import { admitDevice, asAdmitted, newAdmin } from "@/test/identity-fixtures"

import { CheckpointDialog } from "./checkpoint-dialog"
import { HistoryPanel } from "./history-panel"
import { RestoreDialog } from "./restore-dialog"
import { TimelineScrubber } from "./timeline-scrubber"

const T0 = 1_700_000_000_000
const MINUTE = 60 * 1000

afterEach(cleanup)

/** A timeline built the real way: entries plus directory plus readable epochs. */
async function timeline(
  options: { readableEpochs?: number[]; currentId?: string; conflicted?: boolean } = {},
): Promise<{ points: RestorePoint[]; users: User[] }> {
  const adminA = await newAdmin()
  const device = await admitDevice(adminA, { member: "member:ada", label: "Ada Lovelace" })
  const devices = [asAdmitted(device)]

  if (options.conflicted) {
    const adminB = await newAdmin()
    devices.push(asAdmitted(await admitDevice(adminB, { member: "member:ada", label: "A. L." })))
  }
  const user = createUser("member:ada", devices)

  const base = {
    domain: "notebook:travel",
    resourceId: "notebook:travel",
    author: device.record.did,
    parent: null,
    stateHash: "hash",
    materialised: true as const,
  }

  const entries = [
    { ...base, id: "old", kind: "automatic" as const, epoch: 1, covers: {}, createdAt: T0 },
    {
      ...base,
      id: "named",
      kind: "checkpoint" as const,
      epoch: 2,
      covers: {},
      createdAt: T0 + MINUTE,
      label: "Before the rewrite",
    },
    { ...base, id: "join", kind: "join" as const, epoch: 2, covers: {}, createdAt: T0 + 2 * MINUTE },
  ]

  return {
    users: [user],
    points: buildTimeline({
      entries: entries as never,
      users: [user],
      readableEpochs: options.readableEpochs ?? [1, 2],
      ...(options.currentId === undefined ? {} : { currentId: options.currentId }),
    }),
  }
}

function aPlan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    target: { id: "named" } as RestorePlan["target"],
    changed: 12,
    regions: [],
    skipped: [],
    noop: false,
    ...overrides,
  }
}

/* ---- the scrubber -------------------------------------------------------- */

describe("TimelineScrubber", () => {
  it("shows a byline on every point, newest first", async () => {
    const { points } = await timeline()
    render(<TimelineScrubber points={points} onSelect={vi.fn()} now={T0 + 3 * MINUTE} />)

    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(3)
  })

  it("names a checkpoint and marks an access-change point", async () => {
    const { points } = await timeline()
    render(<TimelineScrubber points={points} onSelect={vi.fn()} now={T0 + 3 * MINUTE} />)

    expect(screen.getByText("Before the rewrite")).toBeInTheDocument()
    expect(screen.getByText("Access change")).toBeInTheDocument()
  })

  /** The history exists. Hiding it would be a more comfortable lie. */
  it("lists a point from before this member had access, and says so", async () => {
    const { points } = await timeline({ readableEpochs: [2] })
    render(<TimelineScrubber points={points} onSelect={vi.fn()} now={T0 + 3 * MINUTE} />)

    expect(screen.getByText(/before you had access/)).toBeInTheDocument()
  })

  /**
   * `userLabel()` would throw on a conflict. Rendering a byline must never take
   * the timeline down with it.
   */
  it("renders a conflicted byline as unverified instead of crashing", async () => {
    const { points } = await timeline({ conflicted: true })

    expect(() =>
      render(<TimelineScrubber points={points} onSelect={vi.fn()} now={T0 + 3 * MINUTE} />),
    ).not.toThrow()

    expect(screen.getAllByText(/Two admins recorded different names/).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0)
  })

  it("marks where the document currently is", async () => {
    const { points } = await timeline({ currentId: "join" })
    render(<TimelineScrubber points={points} onSelect={vi.fn()} now={T0 + 3 * MINUTE} />)

    expect(screen.getByText("Where the document is now.")).toBeInTheDocument()
  })

  it("reports a selection to the caller", async () => {
    const { points } = await timeline()
    const onSelect = vi.fn()
    render(<TimelineScrubber points={points} onSelect={onSelect} now={T0 + 3 * MINUTE} />)

    fireEvent.click(screen.getByText("Before the rewrite"))
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "named" })
  })

  it("explains an empty history rather than showing nothing", () => {
    render(<TimelineScrubber points={[]} onSelect={vi.fn()} />)
    expect(screen.getByText(/No restore points yet/)).toBeInTheDocument()
  })
})

/* ---- restore ------------------------------------------------------------- */

describe("RestoreDialog", () => {
  async function setup(
    options: { plan?: RestorePlan | null; pointId?: string; readableEpochs?: number[] } = {},
  ) {
    const { points } = await timeline({ readableEpochs: options.readableEpochs ?? [1, 2] })
    const point = points.find((candidate) => candidate.id === (options.pointId ?? "named"))
    const onRestore = vi.fn().mockResolvedValue(undefined)

    render(
      <RestoreDialog
        open
        onClose={vi.fn()}
        point={point ?? null}
        plan={options.plan === undefined ? aPlan() : options.plan}
        onRestore={onRestore}
      />,
    )
    return { onRestore, point }
  }

  /** The single most important thing to get across. */
  it("says restoring is a new edit, not an undo, and that everyone sees it", async () => {
    await setup()

    expect(screen.getByText("This is a new edit, not an undo.")).toBeInTheDocument()
    expect(screen.getByText(/everyone working here will see it/)).toBeInTheDocument()
    expect(screen.getByText(/appears on the timeline under your name/)).toBeInTheDocument()
  })

  it("says restored writing keeps its original author", async () => {
    await setup()

    expect(screen.getByText("Writing that comes back keeps its author.")).toBeInTheDocument()
    expect(screen.getByText(/recorded as having restored it, not as having written it/)).toBeInTheDocument()
  })

  it("names the people whose writing is coming back", async () => {
    const { points, users } = await timeline()
    render(
      <RestoreDialog
        open
        onClose={vi.fn()}
        point={points[1]}
        plan={aPlan()}
        origins={[
          {
            author: "did:key:zBob",
            member: "member:bob",
            label: "Bob",
            assurance: "invited",
            conflict: null,
            unknown: false,
          },
        ]}
        onRestore={vi.fn()}
      />,
    )
    expect(users).toHaveLength(1)
    expect(screen.getByText(/originally written by Bob stays theirs/)).toBeInTheDocument()
  })

  it("says how much would change, and that what is removed stays in the history", async () => {
    await setup({ plan: aPlan({ changed: 12 }) })

    expect(screen.getByText("12")).toBeInTheDocument()
    expect(screen.getByText(/stays in the history/)).toBeInTheDocument()
  })

  it("refuses a no-op instead of pretending it did something", async () => {
    await setup({ plan: aPlan({ noop: true }) })

    expect(screen.getByText("Nothing would change.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled()
  })

  it("refuses a point from outside the member's visible history", async () => {
    await setup({ pointId: "old", readableEpochs: [2], plan: null })

    expect(screen.getByText("This point is from before you had access.")).toBeInTheDocument()
    expect(screen.getByText(/saved under a key you do not hold/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled()
  })

  /** Silently leaving part of a point behind would be the worse failure. */
  it("says when part of a point cannot be restored", async () => {
    await setup({ plan: aPlan({ skipped: ["comments"] }) })

    expect(screen.getByText("Part of this point cannot be restored.")).toBeInTheDocument()
    expect(screen.getByText(/left alone rather than guessed at/)).toBeInTheDocument()
  })

  it("restores when confirmed", async () => {
    const { onRestore } = await setup()

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    await waitFor(() => expect(onRestore).toHaveBeenCalled())
    expect(onRestore.mock.calls[0][0]).toMatchObject({ id: "named" })
  })
})

/* ---- checkpoints --------------------------------------------------------- */

describe("CheckpointDialog", () => {
  it("says why naming a point matters", () => {
    render(<CheckpointDialog open onClose={vi.fn()} onCreate={vi.fn()} />)

    expect(screen.getByText(/Named points are kept in full/)).toBeInTheDocument()
    expect(screen.getByText(/unnamed ones are tidied away/)).toBeInTheDocument()
  })

  it("will not save an unnamed checkpoint", () => {
    render(<CheckpointDialog open onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Save checkpoint" })).toBeDisabled()
  })

  it("passes the trimmed name to the caller", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<CheckpointDialog open onClose={vi.fn()} onCreate={onCreate} />)

    fireEvent.change(screen.getByLabelText("What to call it"), {
      target: { value: "  Before the rewrite  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save checkpoint" }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Before the rewrite"))
  })
})

/* ---- the panel ----------------------------------------------------------- */

describe("HistoryPanel", () => {
  async function setup(options: { readableEpochs?: number[] } = {}) {
    const { points, users } = await timeline(options)
    const onPlan = vi.fn().mockResolvedValue(aPlan())
    const onRestore = vi.fn().mockResolvedValue(undefined)
    const onCheckpoint = vi.fn().mockResolvedValue(undefined)

    render(
      <HistoryPanel
        points={points}
        users={users}
        onPlan={onPlan}
        onRestore={onRestore}
        onCheckpoint={onCheckpoint}
        now={T0 + 3 * MINUTE}
      />,
    )
    return { onPlan, onRestore, onCheckpoint }
  }

  /** So the dialog promises what the restore will do, not a guess. */
  it("runs the plan before showing the confirmation", async () => {
    const { onPlan } = await setup()

    fireEvent.click(screen.getByText("Before the rewrite"))

    await waitFor(() => expect(onPlan).toHaveBeenCalled())
    expect(await screen.findByRole("dialog", { name: /Go back to/ })).toBeInTheDocument()
    expect(screen.getByText("12")).toBeInTheDocument()
  })

  it("does not plan a point it cannot open", async () => {
    const { onPlan } = await setup({ readableEpochs: [2] })

    // The horizon banner says the same thing, so this is read off the list.
    const list = screen.getByRole("list", { name: "Restore points" })
    fireEvent.click(within(list).getByText(/before you had access/))

    await screen.findByRole("dialog")
    expect(onPlan).not.toHaveBeenCalled()
  })

  it("surfaces a plan failure without opening a misleading confirmation", async () => {
    const { points, users } = await timeline()
    render(
      <HistoryPanel
        points={points}
        users={users}
        onPlan={() => Promise.reject(new Error("snapshot payload is not here"))}
        onRestore={vi.fn()}
        onCheckpoint={vi.fn()}
        now={T0 + 3 * MINUTE}
      />,
    )

    fireEvent.click(screen.getByText("Before the rewrite"))

    expect(await screen.findByText("snapshot payload is not here")).toBeInTheDocument()
    expect(screen.queryByText("12")).not.toBeInTheDocument()
  })

  it("warns once that history exists from before this member had access", async () => {
    await setup({ readableEpochs: [2] })
    expect(screen.getByText(/document existed before you had access/)).toBeInTheDocument()
  })

  it("offers naming the current point", async () => {
    const { onCheckpoint } = await setup()

    fireEvent.click(screen.getByRole("button", { name: /Name this point/ }))
    fireEvent.change(await screen.findByLabelText("What to call it"), {
      target: { value: "Milestone" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save checkpoint" }))

    await waitFor(() => expect(onCheckpoint).toHaveBeenCalledWith("Milestone"))
  })
})
