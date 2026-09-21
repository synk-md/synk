import { describe, expect, it } from "vitest"
import { fromHex, toHex, utf8 } from "./bytes"
import { deriveKey, hkdf } from "./kdf"
import { HKDF_SHA256_VECTORS } from "./vectors"

describe.each(HKDF_SHA256_VECTORS)("HKDF-SHA256 $name", (vector) => {
  it("produces the published output keying material", async () => {
    const out = await hkdf(
      fromHex(vector.ikm),
      fromHex(vector.salt),
      fromHex(vector.info),
      vector.length,
    )
    expect(toHex(out)).toBe(vector.okm)
  })
})

describe("hkdf", () => {
  const ikm = fromHex(HKDF_SHA256_VECTORS[0].ikm)

  it("rejects an out-of-range output length", async () => {
    await expect(hkdf(ikm, new Uint8Array(0), new Uint8Array(0), 0)).rejects.toThrow(/out of range/)
    await expect(hkdf(ikm, new Uint8Array(0), new Uint8Array(0), 255 * 32 + 1)).rejects.toThrow(
      /out of range/,
    )
  })

  // Domain separation is the only thing stopping a key derived for one purpose
  // from being usable for another.
  it("separates outputs by info", async () => {
    const a = await deriveKey(ikm, "synk/epoch/1")
    const b = await deriveKey(ikm, "synk/epoch/2")
    expect(toHex(a)).not.toBe(toHex(b))
    expect(a).toHaveLength(32)
  })

  it("separates outputs by salt", async () => {
    const a = await hkdf(ikm, utf8("salt-a"), utf8("info"), 32)
    const b = await hkdf(ikm, utf8("salt-b"), utf8("info"), 32)
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it("is deterministic", async () => {
    const a = await deriveKey(ikm, "synk/epoch/1")
    const b = await deriveKey(ikm, "synk/epoch/1")
    expect(toHex(a)).toBe(toHex(b))
  })

  // A longer request must extend the shorter one rather than produce unrelated
  // bytes - the sealed box relies on this to split one derivation into key+nonce.
  it("extends rather than replaces when more bytes are asked for", async () => {
    const short = await deriveKey(ikm, "synk/split", 32)
    const long = await deriveKey(ikm, "synk/split", 44)
    expect(toHex(long.subarray(0, 32))).toBe(toHex(short))
  })
})
