import { afterEach, describe, expect, it } from "vitest"
import { curveSupport, resetCurveSupport, setCurveBackend } from "./backend"

afterEach(() => {
  resetCurveSupport()
})

describe("curveSupport", () => {
  it("picks a backend for each curve", async () => {
    const support = await curveSupport()
    expect(["webcrypto", "noble"]).toContain(support.ed25519)
    expect(["webcrypto", "noble"]).toContain(support.x25519)
  })

  // The probe costs two keygens; every call after the first must be free.
  it("memoises the probe result", async () => {
    const first = await curveSupport()
    expect(await curveSupport()).toBe(first)
  })

  it("prefers WebCrypto where the runtime supports the curves", async () => {
    // Node 22 and every browser above the target floor have both. If this ever
    // fails in CI it means the probe regressed, not that support vanished.
    const support = await curveSupport()
    expect(support).toEqual({ ed25519: "webcrypto", x25519: "webcrypto" })
  })
})

describe("setCurveBackend", () => {
  it("applies a single name to both curves", async () => {
    setCurveBackend("noble")
    expect(await curveSupport()).toEqual({ ed25519: "noble", x25519: "noble" })
  })

  it("applies a mixed override", async () => {
    setCurveBackend({ ed25519: "noble", x25519: "webcrypto" })
    expect(await curveSupport()).toEqual({ ed25519: "noble", x25519: "webcrypto" })
  })

  it("clears the override", async () => {
    setCurveBackend("noble")
    setCurveBackend(null)
    expect((await curveSupport()).ed25519).toBe("webcrypto")
  })
})
