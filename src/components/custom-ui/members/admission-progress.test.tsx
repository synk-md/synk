import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AdmissionRun } from "@/hooks/use-note-admission"

import { AdmissionProgress } from "./admission-progress"

afterEach(cleanup)

function run(overrides: Partial<AdmissionRun> = {}): AdmissionRun {
  return {
    progress: null,
    running: false,
    error: null,
    outstanding: [],
    offThread: true,
    ...overrides,
  }
}

const progress = (done: number, total: number, extra: Partial<{ failed: number; skipped: number }> = {}) => ({
  total,
  done,
  skipped: extra.skipped ?? 0,
  failed: extra.failed ?? 0,
  remaining: total - done - (extra.skipped ?? 0),
})

describe("AdmissionProgress", () => {
  it("shows nothing when no admission has run", () => {
    const { container } = render(<AdmissionProgress run={run()} />)
    expect(container).toBeEmptyDOMElement()
  })

  /** The grant is already valid; this is the part that makes it useful. */
  it("says the person is already a member while the notes are covered", () => {
    render(<AdmissionProgress run={run({ running: true, progress: progress(3, 10) })} />)

    expect(screen.getByText(/3 of 10/)).toBeInTheDocument()
    expect(screen.getByText(/already a member/)).toBeInTheDocument()
    expect(screen.getByText(/can be left to finish later/)).toBeInTheDocument()
  })

  it("reports completion against the real total", () => {
    render(<AdmissionProgress run={run({ progress: progress(7, 10, { skipped: 3 }) })} />)
    expect(screen.getByText("All 10 notes are readable to them.")).toBeInTheDocument()
  })

  it("says plainly when nothing needed covering", () => {
    render(<AdmissionProgress run={run({ progress: progress(0, 0) })} />)
    expect(screen.getByText("Nothing needed covering.")).toBeInTheDocument()
  })

  /**
   * Naming them matters: somebody who closed the tab halfway needs to know
   * which notes the new member cannot see, not how many.
   */
  it("names the notes still unreadable to the new member", () => {
    render(
      <AdmissionProgress
        run={run({ progress: progress(1, 3), outstanding: ["kyoto", "osaka"] })}
      />,
    )
    expect(screen.getByText(/Still unreadable to them: kyoto, osaka/)).toBeInTheDocument()
  })

  it("abbreviates a long outstanding list rather than filling the dialog", () => {
    render(
      <AdmissionProgress
        run={run({
          progress: progress(0, 9),
          outstanding: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        })}
      />,
    )
    expect(screen.getByText(/and 3 more/)).toBeInTheDocument()
  })

  it("says failures will be retried rather than reporting them as lost", () => {
    render(<AdmissionProgress run={run({ progress: progress(2, 4, { failed: 2 }) })} />)
    expect(screen.getByText(/2 could not be covered and will be retried/)).toBeInTheDocument()
  })

  it("warns when the work cannot leave the main thread", () => {
    render(
      <AdmissionProgress run={run({ running: true, offThread: false, progress: progress(1, 5) })} />,
    )
    expect(screen.getByText(/cannot do the work in the background/)).toBeInTheDocument()
  })

  it("does not warn about the main thread once it is finished", () => {
    render(<AdmissionProgress run={run({ offThread: false, progress: progress(5, 5) })} />)
    expect(screen.queryByText(/cannot do the work in the background/)).not.toBeInTheDocument()
  })

  it("offers a stop only while it is running", () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <AdmissionProgress run={run({ progress: progress(5, 5) })} onCancel={onCancel} />,
    )
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()

    rerender(
      <AdmissionProgress
        run={run({ running: true, progress: progress(1, 5) })}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("reports a failure without claiming the admission failed", () => {
    render(<AdmissionProgress run={run({ error: "no key for epoch 2" })} />)

    expect(screen.getByText("Could not finish making the notes readable.")).toBeInTheDocument()
    expect(screen.getByText("no key for epoch 2")).toBeInTheDocument()
  })

  it("announces itself without needing focus", () => {
    render(<AdmissionProgress run={run({ running: true, progress: progress(1, 2) })} />)
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })
})
