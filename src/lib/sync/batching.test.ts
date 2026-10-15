import { describe, expect, it, vi } from "vitest"

import { joinWorkspace, newWorkspace, restartClient, settle, textOf } from "@/test/sync-fixtures"

import type { SyncCursor, SyncCursorStore } from "./sync-engine"

function persisted(): SyncCursorStore {
  let cursor: SyncCursor = { seq: 0, clock: 0 }
  return { load: () => cursor, save: (next) => (cursor = next) }
}

const typeOut = (client: Awaited<ReturnType<typeof joinWorkspace>>, text: string) => {
  for (const character of text) {
    client.engine.transact(() => client.text.insert(client.text.length, character))
  }
}

describe("gathering edits", () => {
  /** A transaction per keystroke, and without this an envelope each, kept forever. */
  it("sends a burst of typing as one envelope", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice", { batchMs: 50 })
    const bob = await joinWorkspace(workspace, "bob")

    typeOut(alice, "hello, world")
    await new Promise((resolve) => setTimeout(resolve, 80))
    await settle(alice, bob)

    expect(workspace.relay.size).toBe(1)
    expect(textOf(bob)).toBe("hello, world")
  })

  it("sends each edit alone when not asked to gather", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    typeOut(alice, "hello")
    await settle(alice)
    expect(workspace.relay.size).toBe(5)
  })

  it("does not hold a batch back from an explicit flush", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice", { batchMs: 60_000 })
    const bob = await joinWorkspace(workspace, "bob")

    typeOut(alice, "now")
    await settle(alice, bob)

    expect(textOf(bob)).toBe("now")
  })

  /** Switching away from a note is not abandoning what was typed in it. */
  it("delivers what was gathered when the note is closed", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice", { batchMs: 60_000 })
    const bob = await joinWorkspace(workspace, "bob")

    typeOut(alice, "closing")
    alice.engine.close()
    await alice.engine.flush()
    await settle(bob)

    expect(textOf(bob)).toBe("closing")
  })

  /** Lost with the tab, so it never had a number. Resume finds it by clock. */
  it("recovers a batch that died with the tab", async () => {
    const workspace = await newWorkspace()
    const cursor = persisted()
    let alice = await joinWorkspace(workspace, "alice", { batchMs: 60_000, cursor })
    typeOut(alice, "kept. ")
    await settle(alice)
    typeOut(alice, "lost with the tab.")

    alice = restartClient(workspace, alice, { cursor, abandon: true })
    await alice.engine.resume()
    await alice.engine.sync()
    await settle(alice)

    const bob = await joinWorkspace(workspace, "bob")
    await bob.engine.sync()
    await settle(bob)
    expect(textOf(bob)).toBe("kept. lost with the tab.")
  })

  it("sends a large edit at once rather than waiting", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice", { batchMs: 60_000 })
    alice.engine.transact(() => alice.text.insert(0, "x".repeat(70 * 1024)))
    // Seconds, not the minute the batch would wait: sealing 70 KB takes a while under load.
    await vi.waitFor(() => expect(workspace.relay.size).toBe(1), { timeout: 2000 })
  })
})
