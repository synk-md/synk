/**
 * Redemption attempt limiting.
 *
 * Pure functions over a list of attempt timestamps; the caller persists them.
 * Kept out of the directory because throttling is a local policy decision, not
 * a signed fact, and writing attempt counts into replicated state would let a
 * peer inflate someone else's counter.
 *
 * Honest scope: a 128-bit invitation secret makes guessing infeasible whatever
 * the rate, so this is defence in depth rather than the control - it bounds a
 * leaked-secret replay storm and makes abuse visible. Real enforcement needs a
 * chokepoint every attempt passes through, which is the relay in M8. Until
 * then an attacker who ignores this client simply is not limited.
 */

export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000

export interface RateLimitPolicy {
  maxAttempts?: number
  windowMs?: number
}

export interface RateLimitStatus {
  allowed: boolean
  attemptsInWindow: number
  remaining: number
  /** When the oldest attempt leaves the window, or undefined if not limited. */
  retryAt?: number
}

function withinWindow(attempts: readonly number[], now: number, windowMs: number): number[] {
  return attempts.filter((at) => at > now - windowMs).sort((a, b) => a - b)
}

export function checkRedemptionRate(
  attempts: readonly number[],
  now = Date.now(),
  policy: RateLimitPolicy = {},
): RateLimitStatus {
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const windowMs = policy.windowMs ?? DEFAULT_WINDOW_MS
  const recent = withinWindow(attempts, now, windowMs)
  const allowed = recent.length < maxAttempts

  return {
    allowed,
    attemptsInWindow: recent.length,
    remaining: Math.max(0, maxAttempts - recent.length),
    retryAt: allowed ? undefined : recent[0] + windowMs,
  }
}

/**
 * Append an attempt, dropping ones that have aged out so the list cannot grow
 * without bound on a long-lived invitation.
 */
export function recordRedemptionAttempt(
  attempts: readonly number[],
  now = Date.now(),
  policy: RateLimitPolicy = {},
): number[] {
  return [...withinWindow(attempts, now, policy.windowMs ?? DEFAULT_WINDOW_MS), now]
}
