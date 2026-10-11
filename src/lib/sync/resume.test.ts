import { describe, expect, it } from "vitest"

import {
  joinWorkspace,
  newWorkspace,
  restartClient,
  settle,
  textOf,
  type Client,
} from "@/test/sync-fixtures"

import type { SyncCursor, SyncCursorStore } from "./sync-engine"

/** Stands in for localStorage: survives the engine, not the device. */
function persisted(): SyncCursorStore {
  let cursor: SyncCursor = { seq: 0, clock: 0 }
  return {
    load: () => cursor,
    save: (next) => {
      cursor = next
    },
  }
}

async function caughtUp(client: Client): Promise<void> {
  await client.engine.resume()
  await client.engine.sync()
  await settle(client)
}

describe("surviving a reload", () => {
  /**
   * The relay and every peer dedupe on (author, seq) and answer a duplicate
   * with success. A sequence restarting at 1 after a reload is an edit that
   * looks published and reaches nobody.
   */
  it("keeps delivering edits after a reload", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "before. "))
    await settle(alice, bob)

    alice = restartClient(workspace, alice, { cursor })
    await caughtUp(alice)
    alice.engine.transact(() => alice.text.insert(alice.text.length, "after."))
    await settle(alice, bob)

    expect(textOf(bob)).toBe("before. after.")
  })

  it("never reuses a number the relay holds, even when the local record is lost", async () => {
    const workspace = await newWorkspace()
    let alice = await joinWorkspace(workspace, "alice", { cursor: persisted() })
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "one. "))
    alice.engine.transact(() => alice.text.insert(alice.text.length, "two. "))
    await settle(alice, bob)

    // Site data cleared: the device starts counting from nothing.
    alice = restartClient(workspace, alice, { cursor: persisted() })
    await caughtUp(alice)
    alice.engine.transact(() => alice.text.insert(alice.text.length, "three."))
    await settle(alice, bob)

    expect(textOf(bob)).toBe("one. two. three.")
  })
})

describe("recovering what never arrived", () => {
  /** Published into an outage, then the tab closed: the envelope is gone. */
  it("republishes an edit lost with the tab", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })

    alice.transport.connected = false
    alice.engine.transact(() => alice.text.insert(0, "written offline."))
    await settle(alice)

    alice = restartClient(workspace, alice, { cursor })
    await caughtUp(alice)

    const bob = await joinWorkspace(workspace, "bob")
    await bob.engine.sync()
    await settle(bob)
    expect(textOf(bob)).toBe("written offline.")
  })

  /**
   * Catch-up serves an author's envelopes only up to their first gap. One lost
   * number would hide everything after it from anyone who was not live.
   */
  it("fills a gap so later edits are still served to a latecomer", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })

    alice.engine.transact(() => alice.text.insert(0, "a"))
    await settle(alice)
    alice.transport.connected = false
    alice.engine.transact(() => alice.text.insert(1, "b"))
    await settle(alice)

    alice = restartClient(workspace, alice, { cursor })
    await caughtUp(alice)
    alice.engine.transact(() => alice.text.insert(2, "c"))
    await settle(alice)

    const bob = await joinWorkspace(workspace, "bob")
    await bob.engine.sync()
    await settle(bob)
    expect(textOf(bob)).toBe("abc")
    expect(workspace.relay.vector()[alice.did]).toBeGreaterThanOrEqual(3)
  })

  /** Content from before this engine existed: the switch from the old transport. */
  it("publishes content written while no engine was attached", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })
    alice.engine.close()

    alice.doc.transact(() => alice.text.insert(0, "from before the switch."))

    alice = restartClient(workspace, alice, { cursor })
    await caughtUp(alice)

    const bob = await joinWorkspace(workspace, "bob")
    await bob.engine.sync()
    await settle(bob)
    expect(textOf(bob)).toBe("from before the switch.")
  })

  /** The dev relay keeps nothing across a restart. */
  it("reseeds a relay that forgot everything", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })
    alice.engine.transact(() => alice.text.insert(0, "kept by alice."))
    await settle(alice)

    const fresh = await newWorkspace()
    const restarted = { ...workspace, relay: fresh.relay }
    alice = restartClient(restarted, alice, { cursor })
    await caughtUp(alice)

    const bob = await joinWorkspace(restarted, "bob")
    await bob.engine.sync()
    await settle(bob)
    expect(textOf(bob)).toBe("kept by alice.")
  })

  it("publishes nothing when there is nothing to recover", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { cursor })
    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)
    const before = workspace.relay.size

    alice = restartClient(workspace, alice, { cursor })
    const result = await alice.engine.resume()

    expect(result).toEqual({ filled: 0, republished: false })
    expect(workspace.relay.size).toBe(before)
  })
})

describe("two tabs on one device", () => {
  /**
   * Each tab loaded the cursor when it opened. If another tab has written
   * since, numbering continues from the stored value, not from this one's
   * memory of it.
   */
  it("numbers from the stored cursor when another tab has moved it on", async () => {
    const workspace = await newWorkspace()
    const shared = persisted()
    const alice = await joinWorkspace(workspace, "alice", { cursor: shared })

    // Another tab on this device wrote up to 5 since this engine loaded.
    shared.save({ seq: 5, clock: 0 })

    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)

    expect(workspace.relay.stored().map((envelope) => envelope.seq)).toEqual([6])
  })
})
