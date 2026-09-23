import { describe, expect, it } from "vitest"
import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  DEFAULT_MAX_SUMMARY_AGE_MS,
  FreshnessTracker,
  issueFreshnessSummary,
  revocationSetDigest,
  verifyFreshnessSummary,
  type FreshnessSummary,
} from "./freshness"

const WORKSPACE = "workspace:acme"
const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

async function relay(): Promise<{ key: SigningKey; did: string }> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

async function summary(
  issuer: { key: SigningKey; did: string },
  seq: number,
  ids: string[] = [],
  issuedAt = T0,
): Promise<FreshnessSummary> {
  return issueFreshnessSummary({
    signingKey: issuer.key,
    issuer: issuer.did,
    workspace: WORKSPACE,
    seq,
    revokedIds: ids,
    issuedAt,
  })
}

describe("the summary is signed", () => {
  it("verifies under a trusted issuer", async () => {
    const issuer = await relay()
    const s = await summary(issuer, 1, ["cid-a"])
    expect(await verifyFreshnessSummary(s, [issuer.did])).toBe(true)
    expect(s.count).toBe(1)
  })

  it("refuses an untrusted issuer and a tampered field", async () => {
    const issuer = await relay()
    const stranger = await relay()
    const s = await summary(issuer, 1, ["cid-a"])

    expect(await verifyFreshnessSummary(s, [stranger.did])).toBe(false)
    expect(await verifyFreshnessSummary({ ...s, seq: 99 }, [issuer.did])).toBe(false)
    expect(await verifyFreshnessSummary({ ...s, count: 0 }, [issuer.did])).toBe(false)
    expect(await verifyFreshnessSummary({} as FreshnessSummary, [issuer.did])).toBe(false)
  })

  it("refuses an issuer that did not sign", async () => {
    const issuer = await relay()
    const other = await relay()
    await expect(
      issueFreshnessSummary({
        signingKey: issuer.key,
        issuer: other.did,
        workspace: WORKSPACE,
        seq: 1,
        revokedIds: [],
      }),
    ).rejects.toThrow(/does not match the supplied signing key/)
  })
})

describe("the digest describes the set", () => {
  it("is order-independent", async () => {
    expect(await revocationSetDigest(["b", "a", "c"])).toBe(
      await revocationSetDigest(["a", "b", "c"]),
    )
  })

  it("changes when the contents change", async () => {
    expect(await revocationSetDigest(["a", "b"])).not.toBe(await revocationSetDigest(["a", "c"]))
    expect(await revocationSetDigest([])).not.toBe(await revocationSetDigest(["a"]))
  })
})

describe("staleness is detectable", () => {
  it("reports missing before any summary is seen", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    expect((await tracker.assess(T0)).state).toBe("missing")
  })

  it("reports fresh within the age window", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 1))

    const assessment = await tracker.assess(T0 + 60_000)
    expect(assessment.state).toBe("fresh")
    expect(assessment.ageMs).toBe(60_000)
  })

  // A relay that simply stops forwarding revocations shows up as an ageing
  // summary. That is the whole point of the mechanism.
  it("reports stale once the summary stops advancing", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 1))

    const assessment = await tracker.assess(T0 + DEFAULT_MAX_SUMMARY_AGE_MS + 1)
    expect(assessment.state).toBe("stale")
    expect(assessment.detail).toMatch(/old/)
  })

  it("honours a custom age threshold", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did], HOUR)
    await tracker.offer(await summary(issuer, 1))
    expect((await tracker.assess(T0 + HOUR - 1)).state).toBe("fresh")
    expect((await tracker.assess(T0 + HOUR + 1)).state).toBe("stale")
  })

  // Contents matter, not just the count: a peer with the right number of
  // revocations but the wrong ones is stale too.
  it("detects a local set that disagrees with the digest", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 1, ["cid-a", "cid-b"]))

    const matching = await tracker.assess(T0, ["cid-b", "cid-a"])
    expect(matching.state).toBe("fresh")
    expect(matching.setMismatch).toBeUndefined()

    const wrong = await tracker.assess(T0, ["cid-a", "cid-c"])
    expect(wrong.setMismatch).toBe(true)
    expect(wrong.state).toBe("stale")
  })
})

describe("monotonicity blocks rollback", () => {
  it("accepts an advancing sequence", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])

    expect(await tracker.offer(await summary(issuer, 1))).toBe(true)
    expect(await tracker.offer(await summary(issuer, 2, ["cid-a"], T0 + HOUR))).toBe(true)
    expect(tracker.current?.seq).toBe(2)
  })

  // Replaying an older summary is an attack, not a hiccup: it would hide
  // revocations the peer has already been told about.
  it("refuses a summary older than one already accepted", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 5, ["cid-a"]))

    expect(await tracker.offer(await summary(issuer, 4))).toBe(false)
    expect(tracker.current?.seq).toBe(5)
    expect(tracker.sawRegression).toBe(true)
    expect((await tracker.assess(T0)).state).toBe("regressed")
  })

  it("remembers a regression rather than forgetting it", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 5))
    await tracker.offer(await summary(issuer, 4))
    // A later, valid summary does not erase the fact the relay misbehaved.
    await tracker.offer(await summary(issuer, 6, [], T0 + HOUR))
    expect((await tracker.assess(T0 + HOUR)).state).toBe("regressed")
  })

  it("accepts a repeat of the current sequence without regressing", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    await tracker.offer(await summary(issuer, 3))
    expect(await tracker.offer(await summary(issuer, 3))).toBe(true)
    expect(tracker.sawRegression).toBe(false)
  })

  it("ignores a summary for another workspace", async () => {
    const issuer = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    const other = await issueFreshnessSummary({
      signingKey: issuer.key,
      issuer: issuer.did,
      workspace: "workspace:other",
      seq: 9,
      revokedIds: [],
      issuedAt: T0,
    })
    expect(await tracker.offer(other)).toBe(false)
    expect(tracker.current).toBeUndefined()
  })

  it("refuses an unverifiable summary without recording it", async () => {
    const issuer = await relay()
    const stranger = await relay()
    const tracker = new FreshnessTracker(WORKSPACE, [issuer.did])
    expect(await tracker.offer(await summary(stranger, 1))).toBe(false)
    expect(tracker.current).toBeUndefined()
  })
})
