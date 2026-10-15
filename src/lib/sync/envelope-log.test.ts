import { describe, expect, it } from "vitest"
import { EnvelopeLog } from "./envelope-log"
import type { Envelope } from "./envelope"

function env(author: string, seq: number): Envelope {
  return {
    v: 1,
    kind: "update",
    author,
    seq,
    resourceId: "notebook:1",
    epoch: 1,
    nonce: "n",
    ct: `ct-${author}-${seq}`,
    sig: `sig-${author}-${seq}`,
  }
}

describe("append", () => {
  it("is idempotent per (author, seq)", () => {
    const log = new EnvelopeLog()
    expect(log.append(env("a", 1))).toBe(true)
    expect(log.append(env("a", 1))).toBe(false)
    expect(log.size).toBe(1)
  })

  it("keeps envelopes from several authors", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("b", 1))
    expect(log.size).toBe(2)
    expect(log.has("a", 1)).toBe(true)
    expect(log.has("b", 1)).toBe(true)
    expect(log.has("a", 2)).toBe(false)
  })
})

describe("deliveryVector", () => {
  it("reports the highest contiguous sequence", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("a", 2))
    expect(log.deliveryVector()).toEqual({ a: 2 })
  })

  // Reporting the highest *seen* would lose the gap forever: a peer holding
  // 1,2 and 4 would claim 4 and never be offered 3.
  it("stops at a gap rather than reporting the highest seen", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("a", 2))
    log.append(env("a", 4))
    expect(log.deliveryVector()).toEqual({ a: 2 })
  })

  it("advances across a filled gap", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("a", 3))
    log.append(env("a", 4))
    expect(log.deliveryVector()).toEqual({ a: 1 })

    log.append(env("a", 2))
    expect(log.deliveryVector()).toEqual({ a: 4 })
  })

  it("is empty for an empty log", () => {
    expect(new EnvelopeLog().deliveryVector()).toEqual({})
  })
})

describe("selectSince", () => {
  it("returns only what the asker lacks, in per-author order", () => {
    const log = new EnvelopeLog()
    for (const seq of [1, 2, 3]) log.append(env("a", seq))
    for (const seq of [1, 2]) log.append(env("b", seq))

    expect(log.selectSince({ a: 1, b: 2 }).map((e) => `${e.author}${e.seq}`)).toEqual(["a2", "a3"])
    expect(log.selectSince({}).map((e) => `${e.author}${e.seq}`)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "b2",
    ])
  })

  it("returns nothing when the asker is up to date", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    expect(log.selectSince({ a: 1 })).toEqual([])
    expect(log.selectSince({ a: 5 })).toEqual([])
  })

  // Serving past a gap would hand over envelopes the receiver cannot place.
  it("never serves past a gap", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("a", 3))
    expect(log.selectSince({}).map((e) => e.seq)).toEqual([1])
  })

  it("orders authors deterministically", () => {
    const first = new EnvelopeLog()
    first.append(env("z", 1))
    first.append(env("a", 1))
    const second = new EnvelopeLog()
    second.append(env("a", 1))
    second.append(env("z", 1))

    expect(first.selectSince({}).map((e) => e.author)).toEqual(["a", "z"])
    expect(second.selectSince({}).map((e) => e.author)).toEqual(["a", "z"])
  })
})

describe("bookkeeping", () => {
  it("reports the highest sequence for allocating the next", () => {
    const log = new EnvelopeLog()
    expect(log.highestSeq("a")).toBe(0)
    log.append(env("a", 1))
    log.append(env("a", 7))
    expect(log.highestSeq("a")).toBe(7)
  })

  it("distinguishes an original it holds from an equal-looking copy", () => {
    const log = new EnvelopeLog()
    const original = env("a", 1)
    log.append(original)
    expect(log.holds(original)).toBe(true)
    expect(log.holds({ ...original })).toBe(false)
  })

  it("returns a defensive copy from all()", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.all().push(env("a", 2))
    expect(log.size).toBe(1)
  })
})

/** What a relay does behind a snapshot that covers the envelopes. */
describe("prune", () => {
  it("lets go of what is covered and still offers what follows", () => {
    const log = new EnvelopeLog()
    for (const seq of [1, 2, 3, 4]) log.append(env("a", seq))

    expect(log.prune({ a: 2 })).toBe(2)
    expect(log.floor()).toEqual({ a: 2 })
    expect(log.deliveryVector()).toEqual({ a: 4 })
    expect(log.selectSince({}).map((envelope) => envelope.seq)).toEqual([3, 4])
  })

  /** Republished by a device that never heard it was let go. */
  it("refuses an envelope it already let go", () => {
    const log = new EnvelopeLog()
    for (const seq of [1, 2]) log.append(env("a", seq))
    log.prune({ a: 2 })

    expect(log.append(env("a", 1))).toBe(false)
    expect(log.size).toBe(0)
  })

  it("never runs past a gap", () => {
    const log = new EnvelopeLog()
    log.append(env("a", 1))
    log.append(env("a", 3))

    log.prune({ a: 3 })
    expect(log.floor()).toEqual({ a: 1 })
    expect(log.has("a", 3)).toBe(true)
  })
})
