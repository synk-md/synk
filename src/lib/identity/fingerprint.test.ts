import { describe, expect, it } from "vitest"
import { base32crockford } from "@scure/base"
import { utf8 } from "@/lib/crypto"
import {
  deviceFingerprint,
  FINGERPRINT_BITS,
  FINGERPRINT_CHARS,
  FINGERPRINT_PLACEHOLDER,
  fingerprintsMatch,
} from "./fingerprint"

const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
const DID_B = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG"

describe("the displayed length is a security parameter", () => {
  /**
   * The attack is a second preimage on the truncated digest: generate keypairs
   * until one's fingerprint matches the victim's, then get that key approved
   * instead. Work is ~2^n for n bits shown, offline and parallel.
   *
   *   40 bits  ~10^12 tries - hours on one GPU
   *   80 bits  ~10^24 tries - not worth grinding
   *
   * Shortening this to fit a layout is a security change, so the number is
   * asserted rather than left to a code review to notice.
   */
  it("shows at least 80 bits", () => {
    expect(FINGERPRINT_BITS).toBeGreaterThanOrEqual(80)
    expect(FINGERPRINT_CHARS * 5).toBe(FINGERPRINT_BITS)
  })

  it("renders exactly that many characters", async () => {
    const fingerprint = await deviceFingerprint(DID_A)
    expect(fingerprint.replace(/-/g, "")).toHaveLength(FINGERPRINT_CHARS)
    expect(fingerprint).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/)
  })

  it("has a placeholder of the same shape", () => {
    expect(FINGERPRINT_PLACEHOLDER.replace(/-/g, "")).toHaveLength(FINGERPRINT_CHARS)
    expect(FINGERPRINT_PLACEHOLDER.split("-")).toHaveLength(FINGERPRINT_CHARS / 4)
  })
})

describe("domain separation", () => {
  /**
   * Without a label the fingerprint is just SHA-256 of a DID string - a value
   * anything else might also compute, so a grind against one use would be a
   * grind against all of them.
   */
  it("differs from an unlabelled hash of the same DID", async () => {
    const unlabelled = base32crockford
      .encode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(DID_A) as BufferSource)))
      .slice(0, FINGERPRINT_CHARS)

    expect((await deviceFingerprint(DID_A)).replace(/-/g, "")).not.toBe(unlabelled)
  })

  it("is deterministic and distinct per DID", async () => {
    expect(await deviceFingerprint(DID_A)).toBe(await deviceFingerprint(DID_A))
    expect(await deviceFingerprint(DID_A)).not.toBe(await deviceFingerprint(DID_B))
  })

  // Every Ed25519 did:key shares a multicodec prefix, so truncating the DID
  // itself would show the same leading characters for every device.
  it("does not merely truncate the DID", async () => {
    const a = await deviceFingerprint(DID_A)
    const b = await deviceFingerprint(DID_B)
    expect(DID_A.slice(0, 12)).toBe(DID_B.slice(0, 12))
    expect(a.slice(0, 4)).not.toBe(b.slice(0, 4))
  })
})

describe("fingerprintsMatch", () => {
  it("tolerates case and spacing", async () => {
    const fingerprint = await deviceFingerprint(DID_A)
    expect(fingerprintsMatch(fingerprint, fingerprint)).toBe(true)
    expect(fingerprintsMatch(fingerprint.toLowerCase(), fingerprint)).toBe(true)
    expect(fingerprintsMatch(fingerprint.replace(/-/g, " "), fingerprint)).toBe(true)
    expect(fingerprintsMatch(fingerprint.replace(/-/g, ""), fingerprint)).toBe(true)
  })

  // A short entry must not pass on a prefix - otherwise typing four characters
  // would be enough, and the length would buy nothing.
  it("refuses a truncated entry", async () => {
    const fingerprint = await deviceFingerprint(DID_A)
    const stripped = fingerprint.replace(/-/g, "")

    expect(fingerprintsMatch(stripped.slice(0, 8), fingerprint)).toBe(false)
    expect(fingerprintsMatch(stripped.slice(0, FINGERPRINT_CHARS - 1), fingerprint)).toBe(false)
    expect(fingerprintsMatch("", fingerprint)).toBe(false)
  })

  it("refuses a different fingerprint and an overlong entry", async () => {
    const a = await deviceFingerprint(DID_A)
    const b = await deviceFingerprint(DID_B)
    expect(fingerprintsMatch(a, b)).toBe(false)
    expect(fingerprintsMatch(`${a}X`, a)).toBe(false)
  })
})
