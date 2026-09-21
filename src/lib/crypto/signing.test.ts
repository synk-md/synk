import { afterEach, describe, expect, it } from "vitest"
import { fromHex, toHex, utf8 } from "./bytes"
import { resetCurveSupport, setCurveBackend, type CurveBackendName } from "./backend"
import {
  ED25519_SIGNATURE_BYTES,
  generateSigningKey,
  importSigningKey,
  verifySignature,
} from "./signing"
import { ED25519_VECTORS } from "./vectors"

// Both backends run the same suite. A fallback that is never exercised is a
// fallback that does not work, and the two must be byte-compatible or a peer on
// an older browser would produce signatures nobody else accepts.
const backends: CurveBackendName[] = ["webcrypto", "noble"]

afterEach(() => {
  resetCurveSupport()
})

describe.each(backends)("Ed25519 (%s backend)", (backend) => {
  const use = () => setCurveBackend({ ed25519: backend, x25519: backend })

  describe.each(ED25519_VECTORS)("$name", (vector) => {
    it("derives the published public key", async () => {
      use()
      const key = await importSigningKey(fromHex(vector.secretKey))
      expect(toHex(key.publicKey)).toBe(vector.publicKey)
    })

    it("produces the published signature", async () => {
      use()
      const key = await importSigningKey(fromHex(vector.secretKey))
      const signature = await key.sign(fromHex(vector.message))
      expect(toHex(signature)).toBe(vector.signature)
    })

    it("verifies the published signature", async () => {
      use()
      const valid = await verifySignature(
        fromHex(vector.publicKey),
        fromHex(vector.message),
        fromHex(vector.signature),
      )
      expect(valid).toBe(true)
    })

    it("round-trips the secret key", async () => {
      use()
      const key = await importSigningKey(fromHex(vector.secretKey))
      expect(toHex((await key.exportSecretKey())!)).toBe(vector.secretKey)
    })
  })

  it("rejects a flipped signature bit", async () => {
    use()
    const vector = ED25519_VECTORS[1]
    const signature = fromHex(vector.signature)
    signature[0] ^= 0x01
    expect(await verifySignature(fromHex(vector.publicKey), fromHex(vector.message), signature))
      .toBe(false)
  })

  it("rejects a signature under the wrong public key", async () => {
    use()
    const [first, second] = ED25519_VECTORS
    expect(
      await verifySignature(
        fromHex(second.publicKey),
        fromHex(first.message),
        fromHex(first.signature),
      ),
    ).toBe(false)
  })

  it("rejects a signature over a different message", async () => {
    use()
    const vector = ED25519_VECTORS[2]
    expect(
      await verifySignature(fromHex(vector.publicKey), utf8("not the message"), fromHex(vector.signature)),
    ).toBe(false)
  })

  // Malformed input is attacker-controlled, so it must be a quiet `false`
  // rather than an exception the envelope layer would have to catch separately.
  it("returns false rather than throwing on malformed input", async () => {
    use()
    const vector = ED25519_VECTORS[1]
    expect(await verifySignature(new Uint8Array(31), utf8("x"), fromHex(vector.signature))).toBe(false)
    expect(await verifySignature(fromHex(vector.publicKey), utf8("x"), new Uint8Array(63))).toBe(false)
    expect(await verifySignature(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0))).toBe(false)
  })

  it("generates usable keys", async () => {
    use()
    const key = await generateSigningKey({ extractable: true })
    expect(key.backend).toBe(backend)
    expect(key.publicKey).toHaveLength(32)
    const message = utf8("envelope bytes")
    const signature = await key.sign(message)
    expect(signature).toHaveLength(ED25519_SIGNATURE_BYTES)
    expect(await verifySignature(key.publicKey, message, signature)).toBe(true)
  })

  it("generates distinct keys", async () => {
    use()
    const a = await generateSigningKey()
    const b = await generateSigningKey()
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey))
  })

  it("rejects a secret key of the wrong length", async () => {
    use()
    await expect(importSigningKey(new Uint8Array(31))).rejects.toThrow(/32 bytes/)
  })
})

describe("cross-backend compatibility", () => {
  it("noble verifies a WebCrypto signature and vice versa", async () => {
    const message = utf8("the same envelope, either backend")
    const secretKey = fromHex(ED25519_VECTORS[0].secretKey)

    setCurveBackend("webcrypto")
    const web = await importSigningKey(secretKey)
    const webSig = await web.sign(message)

    setCurveBackend("noble")
    const noble = await importSigningKey(secretKey)
    const nobleSig = await noble.sign(message)

    // Ed25519 is deterministic, so the two backends must agree byte for byte.
    expect(toHex(webSig)).toBe(toHex(nobleSig))
    expect(await verifySignature(web.publicKey, message, webSig)).toBe(true)

    setCurveBackend("webcrypto")
    expect(await verifySignature(noble.publicKey, message, nobleSig)).toBe(true)
  })
})

describe("non-extractable keys", () => {
  it("refuses to hand back a WebCrypto private key", async () => {
    setCurveBackend("webcrypto")
    const key = await generateSigningKey()
    expect(key.extractable).toBe(false)
    expect(await key.exportSecretKey()).toBeNull()
    // Still usable for its actual job - that is the whole point.
    const message = utf8("signed but not readable")
    expect(await verifySignature(key.publicKey, message, await key.sign(message))).toBe(true)
  })

  it("admits that the noble fallback cannot hide the key", async () => {
    setCurveBackend("noble")
    const key = await generateSigningKey()
    expect(key.extractable).toBe(true)
    expect(await key.exportSecretKey()).not.toBeNull()
  })
})
