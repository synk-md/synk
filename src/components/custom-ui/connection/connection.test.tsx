import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { initialStatus, SyncStatusTracker, type SyncStatus } from "@/lib/relay"

import { ConnectionIndicator } from "./connection-indicator"
import { OfflineBanner } from "./offline-banner"
import { RemovedNotice } from "./writer-notice"
import { statusCopy } from "./sync-copy"

const NOW = 1_700_000_000_000

afterEach(cleanup)

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { ...initialStatus(), ...overrides }
}

describe("statusCopy", () => {
  /**
   * The distinction the whole surface rests on: an edit is durable the instant
   * it is typed, and whether anyone else has it is a separate question.
   */
  it("leads every offline state with the fact that work is saved", () => {
    const pending = statusCopy(
      status({ connection: "offline", phase: "offline-pending", pendingOutbound: 3 }),
    )
    const idle = statusCopy(status({ connection: "offline", phase: "offline-idle" }))

    expect(pending.detail).toMatch(/^Saved on this device/)
    expect(idle.detail).toMatch(/^Saved on this device/)
  })

  it("never calls being offline an error", () => {
    for (const phase of ["offline-idle", "offline-pending"] as const) {
      const copy = statusCopy(status({ connection: "offline", phase, pendingOutbound: 1 }))
      // "nothing is lost" is the reassurance, so "lost" alone is not the test.
      expect(copy.detail.toLowerCase()).not.toMatch(/\berror\b|\bfailed\b|\bproblem\b/)
      expect(copy.detail.toLowerCase()).not.toMatch(/(?<!nothing is )\blost\b/)
      expect(copy.tone).not.toBe("trouble")
    }
  })

  it("says nothing is lost while changes are waiting", () => {
    const copy = statusCopy(
      status({ connection: "offline", phase: "offline-pending", pendingOutbound: 2 }),
    )
    expect(copy.detail).toContain("2 changes")
    expect(copy.detail).toMatch(/nothing is lost/i)
  })

  it("names the route it is sharing through", () => {
    expect(statusCopy(status({ phase: "caught-up", route: "relay" })).detail).toContain(
      "through the sync server",
    )
    expect(statusCopy(status({ phase: "caught-up", route: "peer" })).detail).toContain(
      "directly to another device",
    )
  })
})

describe("ConnectionIndicator", () => {
  it("is present when everything is fine, not only when it is not", () => {
    render(<ConnectionIndicator status={status({ connection: "online", phase: "caught-up" })} />)
    expect(screen.getByText("Up to date")).toBeInTheDocument()
  })

  it("announces the state to a screen reader without needing focus", () => {
    render(<ConnectionIndicator status={status({ connection: "online", phase: "syncing" })} />)
    const region = screen.getByRole("status")
    expect(region).toHaveAttribute("aria-live", "polite")
    expect(region).toHaveTextContent("Syncing")
  })

  it("shows how many changes are waiting", () => {
    render(
      <ConnectionIndicator
        status={status({ connection: "offline", phase: "offline-pending", pendingOutbound: 4 })}
      />,
    )
    expect(screen.getByLabelText("4 changes waiting")).toHaveTextContent("4")
  })

  /**
   * One of these the person can do something about and the other they cannot,
   * so they are not the same message.
   */
  it("distinguishes no network from a sync server it cannot reach", () => {
    const offline = status({ connection: "offline", phase: "offline-idle" })

    const { rerender } = render(
      <ConnectionIndicator status={offline} browserOnline={false} expanded now={NOW} />,
    )
    expect(screen.getByText(/no network connection/)).toBeInTheDocument()

    rerender(<ConnectionIndicator status={offline} browserOnline expanded now={NOW} />)
    expect(screen.getByText(/sync server cannot be reached/)).toBeInTheDocument()
    expect(screen.getByText(/Editing is unaffected/)).toBeInTheDocument()
  })

  it("says when work was last shared rather than implying it never was", () => {
    render(
      <ConnectionIndicator
        status={status({ connection: "offline", phase: "offline-pending", pendingOutbound: 1, lastSyncedAt: NOW - 120_000 })}
        expanded
        now={NOW}
      />,
    )
    expect(screen.getByText("Last shared 2 minutes ago.")).toBeInTheDocument()
  })

  it("says plainly that a fresh device has shared nothing yet", () => {
    render(
      <ConnectionIndicator
        status={status({ connection: "online", phase: "caught-up", lastSyncedAt: null })}
        expanded
        now={NOW}
      />,
    )
    expect(screen.getByText(/Nothing has been shared from this device yet/)).toBeInTheDocument()
  })

  it("explains that the server is a convenience, not a requirement", () => {
    render(<ConnectionIndicator status={status({ connection: "online", phase: "caught-up" })} expanded />)
    expect(screen.getByText(/cannot read them, and it is never needed/)).toBeInTheDocument()
  })

  it("offers a retry only when there is something to retry", () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <ConnectionIndicator
        status={status({ connection: "online", phase: "caught-up" })}
        expanded
        onRetry={onRetry}
      />,
    )
    expect(screen.queryByText("Try reconnecting")).not.toBeInTheDocument()

    rerender(
      <ConnectionIndicator
        status={status({ connection: "offline", phase: "offline-pending", pendingOutbound: 1 })}
        expanded
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByText("Try reconnecting"))
    expect(onRetry).toHaveBeenCalled()
  })
})

describe("OfflineBanner", () => {
  it("appears only when something is actually waiting", () => {
    const { rerender, container } = render(
      <OfflineBanner status={status({ connection: "offline", phase: "offline-idle" })} />,
    )
    expect(container).toBeEmptyDOMElement()

    rerender(
      <OfflineBanner
        status={status({ connection: "offline", phase: "offline-pending", pendingOutbound: 2 })}
      />,
    )
    expect(screen.getByText(/2 changes are waiting/)).toBeInTheDocument()
  })

  it("reassures rather than warns", () => {
    render(
      <OfflineBanner
        status={status({ connection: "offline", phase: "offline-pending", pendingOutbound: 1 })}
      />,
    )
    expect(screen.getByText(/saved on this device and will sync/)).toBeInTheDocument()
    // A status, not an alert: being offline is supported, not a fault.
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("end to end through the tracker", () => {
  /** What someone on a train actually sees, in order. */
  it("moves from caught up to offline-with-work to syncing to caught up", () => {
    const tracker = new SyncStatusTracker()
    const seen: string[] = []
    tracker.subscribe((current) => {
      seen.push(statusCopy(current).label)
    })

    tracker.setConnection("online")
    // Learning the route is its own change: the detail line names it, so the
    // label repeats while the sentence under it does not.
    tracker.setRoute("relay")
    tracker.setConnection("offline")
    tracker.setPending(3)
    tracker.setConnection("online")
    tracker.setPending(0)

    expect(seen).toEqual([
      "Offline",
      "Up to date",
      "Up to date",
      "Offline",
      "Offline",
      "Syncing",
      "Up to date",
    ])
  })
})

describe("RemovedNotice", () => {
  /** Says what changed and what did not, so a read-only note is not mistaken for a fault. */
  it("says access ended, and that nothing written here would reach anyone", () => {
    render(<RemovedNotice />)
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer have access/)
    expect(screen.getByRole("alert")).toHaveTextContent(/stays here to read/)
    expect(screen.getByRole("alert")).toHaveTextContent(/would reach anyone/)
  })
})
