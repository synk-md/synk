/**
 * Chooses the implementation backing the curve operations.
 *
 * WebCrypto first, because only it can hold a key non-extractably; `@noble` is
 * the fallback below the Ed25519/X25519 browser floor. Detection is a real
 * functional probe, not a name check.
 */

export type CurveBackendName = "webcrypto" | "noble"

export interface CurveSupport {
  ed25519: CurveBackendName
  x25519: CurveBackendName
}

let cached: Promise<CurveSupport> | null = null
let override: CurveSupport | null = null

async function probeEd25519(): Promise<boolean> {
  try {
    const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])
    const message = new Uint8Array([0x73, 0x79, 0x6e, 0x6b])
    const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, message)
    return await crypto.subtle.verify("Ed25519", pair.publicKey, signature, message)
  } catch {
    return false
  }
}

async function probeX25519(): Promise<boolean> {
  try {
    const a = (await crypto.subtle.generateKey("X25519", false, [
      "deriveBits",
    ])) as CryptoKeyPair
    const b = (await crypto.subtle.generateKey("X25519", false, [
      "deriveBits",
    ])) as CryptoKeyPair
    const ab = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256),
    )
    const ba = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: a.publicKey }, b.privateKey, 256),
    )
    if (ab.length !== 32) return false
    let diff = 0
    for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ ba[i]
    return diff === 0
  } catch {
    return false
  }
}

/**
 * Resolved once per process. The probe costs two keygens, so callers should not
 * assume it is free on the first call - but every call after that is a hit on
 * the memoised promise.
 */
export function curveSupport(): Promise<CurveSupport> {
  if (override) return Promise.resolve(override)
  if (!cached) {
    cached = (async () => {
      const hasSubtle = typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined"
      if (!hasSubtle) return { ed25519: "noble" as const, x25519: "noble" as const }
      const [ed, x] = await Promise.all([probeEd25519(), probeX25519()])
      return {
        ed25519: ed ? ("webcrypto" as const) : ("noble" as const),
        x25519: x ? ("webcrypto" as const) : ("noble" as const),
      }
    })()
  }
  return cached
}

/**
 * Force a backend. Exists so the test suite can run the *same* known-answer
 * vectors through both implementations - a fallback that is never exercised is
 * a fallback that does not work.
 */
export function setCurveBackend(next: CurveBackendName | CurveSupport | null): void {
  if (next === null) {
    override = null
    return
  }
  override = typeof next === "string" ? { ed25519: next, x25519: next } : next
}

/** Drops the memoised probe result. Test-only. */
export function resetCurveSupport(): void {
  cached = null
  override = null
}
