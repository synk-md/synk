import { describe, expect, it } from "vitest"
import { SingleWriterGuard, webLockBackend, writerLockName, type LockBackend } from "./single-writer"

/** Stands in for Web Locks, which jsdom does not provide. */
function stubBackend(): LockBackend {
  const held = new Set<string>()
  return {
    acquire(name) {
      if (held.has(name)) return Promise.resolve(null)
      held.add(name)
      return Promise.resolve(() => held.delete(name))
    },
  }
}

describe("SingleWriterGuard", () => {
  it("grants leadership to the first claimant only", async () => {
    const backend = stubBackend()
    const name = writerLockName("did:key:zDevice", "notebook:1")

    const first = new SingleWriterGuard({ name, backend })
    const second = new SingleWriterGuard({ name, backend })

    expect(await first.claim()).toBe("leader")
    expect(await second.claim()).toBe("follower")
    expect(first.isLeader).toBe(true)
    expect(second.isLeader).toBe(false)
  })

  // A crashed or closed leader must not strand the others.
  it("lets a follower take over once the leader yields", async () => {
    const backend = stubBackend()
    const name = writerLockName("did:key:zDevice", "notebook:1")
    const first = new SingleWriterGuard({ name, backend })
    const second = new SingleWriterGuard({ name, backend })

    await first.claim()
    await second.claim()
    expect(second.isLeader).toBe(false)

    first.yield()
    expect(await second.claim()).toBe("leader")
  })

  it("is idempotent for a holder that claims twice", async () => {
    const backend = stubBackend()
    const guard = new SingleWriterGuard({ name: "n", backend })
    expect(await guard.claim()).toBe("leader")
    expect(await guard.claim()).toBe("leader")
  })

  // Documents on the same device must not contend with each other.
  it("scopes the lock per device and document", async () => {
    const backend = stubBackend()
    const a = new SingleWriterGuard({
      name: writerLockName("did:key:zDevice", "notebook:1"),
      backend,
    })
    const b = new SingleWriterGuard({
      name: writerLockName("did:key:zDevice", "notebook:2"),
      backend,
    })
    expect(await a.claim()).toBe("leader")
    expect(await b.claim()).toBe("leader")
  })

  // Reporting "unavailable" rather than silently claiming leadership leaves the
  // decision with the caller.
  it("reports unavailable when no backend exists", async () => {
    const guard = new SingleWriterGuard({ name: "n" })
    expect(webLockBackend()).toBeUndefined()
    expect(await guard.claim()).toBe("unavailable")
    expect(guard.isLeader).toBe(false)
  })
})

describe("writerLockName", () => {
  it("is distinct per device and resource", () => {
    expect(writerLockName("a", "r")).not.toBe(writerLockName("b", "r"))
    expect(writerLockName("a", "r1")).not.toBe(writerLockName("a", "r2"))
    expect(writerLockName("a", "r")).toBe(writerLockName("a", "r"))
  })
})
