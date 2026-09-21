import { describe, expect, it } from "vitest"
import {
  assertLength,
  concat,
  equalBytes,
  fromBase64Url,
  fromHex,
  randomBytes,
  toBase64Url,
  toHex,
  utf8,
  wipe,
} from "./bytes"

describe("hex", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = randomBytes(64)
    expect(toHex(fromHex(toHex(bytes)))).toBe(toHex(bytes))
  })

  it("pads single-digit bytes", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff")
  })

  it("rejects malformed hex", () => {
    expect(() => fromHex("abc")).toThrow(/even length/)
    expect(() => fromHex("zz")).toThrow(/invalid hex/)
  })
})

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = randomBytes(65)
    expect(toHex(fromBase64Url(toBase64Url(bytes)))).toBe(toHex(bytes))
  })

  // Capability tokens are JWT-compact, so the encoding must be unpadded and use
  // the URL alphabet or a token stops surviving the round trip.
  it("uses the url alphabet without padding", () => {
    const encoded = toBase64Url(new Uint8Array([0xfb, 0xff, 0xbe]))
    expect(encoded).not.toMatch(/[+/=]/)
    expect(toHex(fromBase64Url(encoded))).toBe("fbffbe")
  })

  it("handles every input length modulo 3", () => {
    for (const length of [0, 1, 2, 3, 4, 5]) {
      const bytes = randomBytes(length)
      expect(toHex(fromBase64Url(toBase64Url(bytes)))).toBe(toHex(bytes))
    }
  })
})

describe("utf8", () => {
  it("encodes non-ascii text", () => {
    expect(toHex(utf8("æ"))).toBe("c3a6")
  })
})

describe("concat", () => {
  it("joins in order", () => {
    expect(toHex(concat(fromHex("0011"), new Uint8Array(0), fromHex("22")))).toBe("001122")
  })

  it("returns an empty array for no parts", () => {
    expect(concat()).toHaveLength(0)
  })
})

describe("equalBytes", () => {
  it("compares content, not identity", () => {
    expect(equalBytes(fromHex("00ff"), fromHex("00ff"))).toBe(true)
  })

  it("rejects different lengths and differing bytes", () => {
    expect(equalBytes(fromHex("00ff"), fromHex("00"))).toBe(false)
    expect(equalBytes(fromHex("00ff"), fromHex("01ff"))).toBe(false)
    expect(equalBytes(fromHex("00ff"), fromHex("00fe"))).toBe(false)
  })

  it("treats empty arrays as equal", () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true)
  })
})

describe("randomBytes", () => {
  it("returns the requested length and does not repeat", () => {
    expect(randomBytes(32)).toHaveLength(32)
    expect(toHex(randomBytes(32))).not.toBe(toHex(randomBytes(32)))
  })
})

describe("wipe", () => {
  it("zeroes in place", () => {
    const bytes = randomBytes(32)
    wipe(bytes)
    expect(toHex(bytes)).toBe("00".repeat(32))
  })
})

describe("assertLength", () => {
  it("passes the value through when the length matches", () => {
    const bytes = randomBytes(32)
    expect(assertLength(bytes, 32, "key")).toBe(bytes)
  })

  it("names the value and both lengths when it does not", () => {
    expect(() => assertLength(randomBytes(31), 32, "Ed25519 secret key")).toThrow(
      "Ed25519 secret key must be 32 bytes, got 31",
    )
  })
})
