import { describe, expect, it } from "vitest"
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  generateAeadKey,
  randomNonce,
} from "./aead"
import { concat, fromHex, toHex, utf8 } from "./bytes"
import { AES_256_GCM_VECTORS } from "./vectors"

describe.each(AES_256_GCM_VECTORS)("AES-256-GCM $name", (vector) => {
  const key = () => fromHex(vector.key)
  const nonce = () => fromHex(vector.nonce)
  const aad = () => (vector.aad ? fromHex(vector.aad) : undefined)
  const expected = vector.ciphertext + vector.tag

  it("produces the published ciphertext and tag", async () => {
    const out = await aeadEncrypt(key(), nonce(), fromHex(vector.plaintext), aad())
    expect(toHex(out)).toBe(expected)
  })

  it("decrypts back to the published plaintext", async () => {
    const out = await aeadDecrypt(key(), nonce(), fromHex(expected), aad())
    expect(toHex(out)).toBe(vector.plaintext)
  })
})

describe("AES-256-GCM rejection", () => {
  const vector = AES_256_GCM_VECTORS[3]
  const sealed = () => fromHex(vector.ciphertext + vector.tag)

  it("rejects a tampered ciphertext", async () => {
    const bad = sealed()
    bad[0] ^= 0xff
    await expect(
      aeadDecrypt(fromHex(vector.key), fromHex(vector.nonce), bad, fromHex(vector.aad)),
    ).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects a tampered tag", async () => {
    const bad = sealed()
    bad[bad.length - 1] ^= 0x01
    await expect(
      aeadDecrypt(fromHex(vector.key), fromHex(vector.nonce), bad, fromHex(vector.aad)),
    ).rejects.toThrow(/AEAD open failed/)
  })

  // The whole reason envelope headers go in the aad: change the claimed author
  // and the ciphertext stops opening.
  it("rejects modified associated data", async () => {
    const aad = fromHex(vector.aad)
    aad[0] ^= 0x01
    await expect(
      aeadDecrypt(fromHex(vector.key), fromHex(vector.nonce), sealed(), aad),
    ).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects omitted associated data", async () => {
    await expect(
      aeadDecrypt(fromHex(vector.key), fromHex(vector.nonce), sealed()),
    ).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects the wrong key", async () => {
    const key = fromHex(vector.key)
    key[0] ^= 0x01
    await expect(
      aeadDecrypt(key, fromHex(vector.nonce), sealed(), fromHex(vector.aad)),
    ).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects the wrong nonce", async () => {
    const nonce = fromHex(vector.nonce)
    nonce[0] ^= 0x01
    await expect(
      aeadDecrypt(fromHex(vector.key), nonce, sealed(), fromHex(vector.aad)),
    ).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects wrong-sized keys and nonces up front", async () => {
    await expect(aeadEncrypt(new Uint8Array(16), randomNonce(), utf8("x"))).rejects.toThrow(
      /32 bytes/,
    )
    await expect(aeadEncrypt(generateAeadKey(), new Uint8Array(16), utf8("x"))).rejects.toThrow(
      /12 bytes/,
    )
  })

  it("rejects a ciphertext too short to hold a tag", async () => {
    await expect(
      aeadDecrypt(generateAeadKey(), randomNonce(), new Uint8Array(AEAD_TAG_BYTES - 1)),
    ).rejects.toThrow(/shorter than GCM tag/)
  })
})

describe("generated key material", () => {
  it("has the documented sizes and is not constant", () => {
    const a = generateAeadKey()
    const b = generateAeadKey()
    expect(a).toHaveLength(AEAD_KEY_BYTES)
    expect(randomNonce()).toHaveLength(AEAD_NONCE_BYTES)
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it("round-trips a realistic update payload under a fresh key", async () => {
    const key = generateAeadKey()
    const nonce = randomNonce()
    const payload = concat(utf8("yjs-update:"), new Uint8Array(4096).fill(0xab))
    const aad = utf8("author|7|notebook:1")
    const sealed = await aeadEncrypt(key, nonce, payload, aad)
    expect(sealed).toHaveLength(payload.length + AEAD_TAG_BYTES)
    expect(toHex(await aeadDecrypt(key, nonce, sealed, aad))).toBe(toHex(payload))
  })
})
