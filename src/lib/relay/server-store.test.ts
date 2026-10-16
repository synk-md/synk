import { describe, expect, it } from "vitest"

import type { Snapshot } from "@/lib/snapshots"

import { DEFAULT_QUOTA, RelayStore } from "./server-store"

/** Only what the archive reads: its id, resource, kind and label are not sealed. */
function aSnapshot(id: string, kind: Snapshot["kind"], label?: string): Snapshot {
  return { id, resourceId: "notebook:a/note:b", kind, ...(label ? { label } : {}) } as unknown as Snapshot
}

describe("the relay's snapshot archive", () => {
  /** A checkpoint was named on purpose; an automatic point is a convenience. */
  it("sheds automatic points before named checkpoints when it is full", () => {
    const store = new RelayStore({ ...DEFAULT_QUOTA, maxSnapshotsPerResource: 3 })
    store.archive(aSnapshot("checkpoint-1", "checkpoint", "Before the rewrite"))
    store.archive(aSnapshot("auto-1", "automatic"))
    store.archive(aSnapshot("auto-2", "automatic"))
    store.archive(aSnapshot("auto-3", "automatic"))

    expect(store.archived("notebook:a/note:b").map((snapshot) => snapshot.id)).toEqual([
      "checkpoint-1",
      "auto-2",
      "auto-3",
    ])
  })

  it("sheds the oldest when everything left is a checkpoint", () => {
    const store = new RelayStore({ ...DEFAULT_QUOTA, maxSnapshotsPerResource: 2 })
    for (const id of ["one", "two", "three"]) store.archive(aSnapshot(id, "checkpoint", id))
    expect(store.archived("notebook:a/note:b").map((snapshot) => snapshot.id)).toEqual(["two", "three"])
  })
})

describe("who the relay takes to own a notebook", () => {
  const genesis = (owner: string) =>
    ({ owner, resource: "notebook:a", workspace: "workspace:a" }) as unknown as Parameters<RelayStore["claimOwnership"]>[0]

  it("moves on to whoever took over, and is not wound back by a claim that stops short", () => {
    const store = new RelayStore()
    store.claimOwnership(genesis("did:key:zLaptop"))
    expect(store.claimOwnership(genesis("did:key:zLaptop"), [], ["did:key:zLaptop", "did:key:zPhone"]).owner).toBe("did:key:zPhone")
    // The lost laptop, claiming with the bare genesis.
    expect(store.claimOwnership(genesis("did:key:zLaptop")).owner).toBe("did:key:zPhone")
  })

  it("is disputed by a claim from a different founder", () => {
    const store = new RelayStore()
    store.claimOwnership(genesis("did:key:zLaptop"))
    expect(store.claimOwnership(genesis("did:key:zRival")).disputed).toBe(true)
  })
})
