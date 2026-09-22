import { describe, expect, it } from "vitest"
import { generateAeadKey, toHex } from "@/lib/crypto"
import {
  deriveChainedEpochKey,
  genesisEpoch,
  isReachable,
  reachableEpochs,
  resolveEpochKey,
  segmentStart,
  timelineIsWellFormed,
  type EpochRecord,
  type EpochTimeline,
} from "./epochs"

const DOMAIN = "notebook:1"

function record(epoch: number, kind: EpochRecord["kind"]): EpochRecord {
  return {
    v: 1,
    domain: DOMAIN,
    epoch,
    kind,
    reason: kind === "genesis" ? "genesis" : kind === "chain" ? "member-added" : "member-removed",
    createdAt: epoch * 1000,
  }
}

/** genesis, join, join, removal, join - the shape the properties are about. */
const TIMELINE: EpochTimeline = [
  record(1, "genesis"),
  record(2, "chain"),
  record(3, "chain"),
  record(4, "rotation"),
  record(5, "chain"),
]

describe("the chain step", () => {
  it("is deterministic and one-way", async () => {
    const key = generateAeadKey()
    const next = await deriveChainedEpochKey(key)
    expect(toHex(await deriveChainedEpochKey(key))).toBe(toHex(next))
    expect(toHex(next)).not.toBe(toHex(key))
    expect(next).toHaveLength(32)
  })

  it("diverges for different inputs", async () => {
    const a = await deriveChainedEpochKey(generateAeadKey())
    const b = await deriveChainedEpochKey(generateAeadKey())
    expect(toHex(a)).not.toBe(toHex(b))
  })
})

describe("segmentStart", () => {
  it("finds the most recent non-chained epoch", () => {
    expect(segmentStart(TIMELINE, 1)).toBe(1)
    expect(segmentStart(TIMELINE, 3)).toBe(1)
    expect(segmentStart(TIMELINE, 4)).toBe(4)
    expect(segmentStart(TIMELINE, 5)).toBe(4)
  })
})

describe("isReachable", () => {
  // History exclusion: the chain is one-way.
  it("never reaches backwards", () => {
    expect(isReachable(TIMELINE, 3, 1)).toBe(false)
    expect(isReachable(TIMELINE, 3, 2)).toBe(false)
  })

  it("reaches forward within a segment", () => {
    expect(isReachable(TIMELINE, 1, 2)).toBe(true)
    expect(isReachable(TIMELINE, 1, 3)).toBe(true)
    expect(isReachable(TIMELINE, 4, 5)).toBe(true)
  })

  // Removal: a rotation is a wall the chain cannot cross.
  it("never reaches across a rotation", () => {
    expect(isReachable(TIMELINE, 1, 4)).toBe(false)
    expect(isReachable(TIMELINE, 3, 4)).toBe(false)
    expect(isReachable(TIMELINE, 3, 5)).toBe(false)
  })

  it("reaches an epoch it is anchored at", () => {
    expect(isReachable(TIMELINE, 4, 4)).toBe(true)
  })

  it("does not reach past the end of the timeline", () => {
    expect(isReachable(TIMELINE, 1, 6)).toBe(false)
  })
})

describe("resolveEpochKey", () => {
  it("returns a held anchor directly", async () => {
    const key = generateAeadKey()
    const resolved = await resolveEpochKey(TIMELINE, new Map([[1, key]]), 1)
    expect(toHex(resolved!)).toBe(toHex(key))
  })

  it("derives forward within a segment", async () => {
    const key = generateAeadKey()
    const expected = await deriveChainedEpochKey(await deriveChainedEpochKey(key))
    const resolved = await resolveEpochKey(TIMELINE, new Map([[1, key]]), 3)
    expect(toHex(resolved!)).toBe(toHex(expected))
  })

  it("returns undefined across a rotation or backwards", async () => {
    const anchors = new Map([[1, generateAeadKey()]])
    expect(await resolveEpochKey(TIMELINE, anchors, 4)).toBeUndefined()
    expect(await resolveEpochKey(TIMELINE, new Map([[3, generateAeadKey()]]), 2)).toBeUndefined()
  })

  it("uses the closest usable anchor", async () => {
    const genesis = generateAeadKey()
    const afterRotation = generateAeadKey()
    const anchors = new Map([
      [1, genesis],
      [4, afterRotation],
    ])
    const expected = await deriveChainedEpochKey(afterRotation)
    expect(toHex((await resolveEpochKey(TIMELINE, anchors, 5))!)).toBe(toHex(expected))
  })

  it("returns undefined with no anchors at all", async () => {
    expect(await resolveEpochKey(TIMELINE, new Map(), 1)).toBeUndefined()
  })
})

describe("reachableEpochs", () => {
  it("lists exactly what a member can decrypt", () => {
    expect(reachableEpochs(TIMELINE, new Map([[1, generateAeadKey()]]))).toEqual([1, 2, 3])
    expect(reachableEpochs(TIMELINE, new Map([[3, generateAeadKey()]]))).toEqual([3])
    expect(reachableEpochs(TIMELINE, new Map([[4, generateAeadKey()]]))).toEqual([4, 5])
    expect(
      reachableEpochs(
        TIMELINE,
        new Map([
          [1, generateAeadKey()],
          [4, generateAeadKey()],
        ]),
      ),
    ).toEqual([1, 2, 3, 4, 5])
  })

  it("is empty with no anchors", () => {
    expect(reachableEpochs(TIMELINE, new Map())).toEqual([])
  })
})

describe("timelineIsWellFormed", () => {
  it("accepts a contiguous timeline starting at genesis", () => {
    expect(timelineIsWellFormed(TIMELINE)).toBe(true)
    expect(timelineIsWellFormed([genesisEpoch(DOMAIN)])).toBe(true)
  })

  it("rejects gaps, a missing genesis, a second genesis and mixed domains", () => {
    expect(timelineIsWellFormed([])).toBe(false)
    expect(timelineIsWellFormed([record(1, "genesis"), record(3, "chain")])).toBe(false)
    expect(timelineIsWellFormed([record(1, "chain")])).toBe(false)
    expect(timelineIsWellFormed([record(1, "genesis"), record(2, "genesis")])).toBe(false)
    expect(
      timelineIsWellFormed([record(1, "genesis"), { ...record(2, "chain"), domain: "other" }]),
    ).toBe(false)
  })
})
