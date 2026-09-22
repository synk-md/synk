import { describe, expect, it } from "vitest"
import {
  checkRedemptionRate,
  DEFAULT_MAX_ATTEMPTS,
  recordRedemptionAttempt,
} from "./rate-limit"

const T0 = 1_700_000_000_000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

describe("checkRedemptionRate", () => {
  it("allows until the cap is reached", () => {
    const attempts = Array.from({ length: DEFAULT_MAX_ATTEMPTS - 1 }, (_, i) => T0 - i * MINUTE)
    const status = checkRedemptionRate(attempts, T0)
    expect(status.allowed).toBe(true)
    expect(status.remaining).toBe(1)
  })

  it("denies at the cap and says when to retry", () => {
    const oldest = T0 - 30 * MINUTE
    const attempts = [oldest, ...Array.from({ length: DEFAULT_MAX_ATTEMPTS - 1 }, () => T0)]
    const status = checkRedemptionRate(attempts, T0)

    expect(status.allowed).toBe(false)
    expect(status.remaining).toBe(0)
    expect(status.retryAt).toBe(oldest + HOUR)
  })

  // A sliding window, not a fixed bucket: old attempts stop counting.
  it("forgets attempts that have aged out", () => {
    const stale = Array.from({ length: 10 }, (_, i) => T0 - 2 * HOUR - i * MINUTE)
    expect(checkRedemptionRate(stale, T0).allowed).toBe(true)
    expect(checkRedemptionRate(stale, T0).attemptsInWindow).toBe(0)
  })

  it("honours a custom policy", () => {
    const attempts = [T0, T0]
    expect(checkRedemptionRate(attempts, T0, { maxAttempts: 2 }).allowed).toBe(false)
    expect(checkRedemptionRate(attempts, T0, { maxAttempts: 3 }).allowed).toBe(true)
    expect(
      checkRedemptionRate([T0 - 10 * MINUTE], T0, { maxAttempts: 1, windowMs: MINUTE }).allowed,
    ).toBe(true)
  })

  it("allows an empty history", () => {
    expect(checkRedemptionRate([], T0).allowed).toBe(true)
  })
})

describe("recordRedemptionAttempt", () => {
  it("appends the attempt", () => {
    expect(recordRedemptionAttempt([], T0)).toEqual([T0])
  })

  // Otherwise a long-lived invitation accumulates an unbounded list.
  it("drops attempts that have aged out", () => {
    const attempts = [T0 - 3 * HOUR, T0 - 2 * HOUR, T0 - MINUTE]
    expect(recordRedemptionAttempt(attempts, T0)).toEqual([T0 - MINUTE, T0])
  })

  it("does not mutate its input", () => {
    const attempts = [T0 - MINUTE]
    recordRedemptionAttempt(attempts, T0)
    expect(attempts).toEqual([T0 - MINUTE])
  })

  it("drives the limit when used together", () => {
    let attempts: number[] = []
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i += 1) {
      expect(checkRedemptionRate(attempts, T0).allowed).toBe(true)
      attempts = recordRedemptionAttempt(attempts, T0)
    }
    expect(checkRedemptionRate(attempts, T0).allowed).toBe(false)
    // An hour later the window has slid clear.
    expect(checkRedemptionRate(attempts, T0 + HOUR + 1).allowed).toBe(true)
  })
})
