import { afterEach, describe, expect, it } from "vitest"
import { generateAeadKey } from "./aead"
import { resetCurveSupport, setCurveBackend, type CurveBackendName } from "./backend"
import { fromHex, toHex, utf8 } from "./bytes"
import {
  generateSealingKey,
  importSealingKey,
  seal,
  X25519_PUBLIC_KEY_BYTES,
  x25519Agree,
  x25519PublicKey,
} from "./sealing"
import { X25519_ECDH_VECTOR, X25519_SCALARMULT_VECTORS } from "./vectors"

const backends: CurveBackendName[] = ["webcrypto", "noble"]

afterEach(() => {
  resetCurveSupport()
})

describe.each(backends)("X25519 (%s backend)", (backend) => {
  const use = () => setCurveBackend({ ed25519: backend, x25519: backend })

  describe.each(X25519_SCALARMULT_VECTORS)("$name", (vector) => {
    it("matches the published scalar multiplication result", async () => {
      use()
      expect(toHex(await x25519Agree(fromHex(vector.scalar), fromHex(vector.u)))).toBe(vector.output)
    })
  })

  it("derives the published public keys", () => {
    use()
    const v = X25519_ECDH_VECTOR
    expect(toHex(x25519PublicKey(fromHex(v.aliceSecretKey)))).toBe(v.alicePublicKey)
    expect(toHex(x25519PublicKey(fromHex(v.bobSecretKey)))).toBe(v.bobPublicKey)
  })

  it("reaches the published shared secret from both sides", async () => {
    use()
    const v = X25519_ECDH_VECTOR
    expect(toHex(await x25519Agree(fromHex(v.aliceSecretKey), fromHex(v.bobPublicKey)))).toBe(
      v.sharedSecret,
    )
    expect(toHex(await x25519Agree(fromHex(v.bobSecretKey), fromHex(v.alicePublicKey)))).toBe(
      v.sharedSecret,
    )
  })

  it("rejects a low-order public key", async () => {
    use()
    // All-zero u is the canonical low-order point; agreeing with it yields an
    // all-zero secret, which both backends must refuse rather than return.
    await expect(
      x25519Agree(fromHex(X25519_ECDH_VECTOR.aliceSecretKey), new Uint8Array(32)),
    ).rejects.toThrow(/X25519 agreement failed/)
  })

  it("rejects wrong-length inputs", async () => {
    use()
    await expect(x25519Agree(new Uint8Array(31), new Uint8Array(32))).rejects.toThrow(/32 bytes/)
    await expect(x25519Agree(new Uint8Array(32), new Uint8Array(31))).rejects.toThrow(/32 bytes/)
  })
})

describe.each(backends)("sealed box (%s backend)", (backend) => {
  const use = () => setCurveBackend({ ed25519: backend, x25519: backend })

  it("round-trips an epoch DEK to its recipient", async () => {
    use()
    const member = await generateSealingKey()
    const dek = generateAeadKey()
    const box = await seal(member.publicKey, dek)
    expect(toHex(await member.open(box))).toBe(toHex(dek))
  })

  it("prefixes the box with the ephemeral public key and nothing else", async () => {
    use()
    const member = await generateSealingKey()
    const dek = generateAeadKey()
    const box = await seal(member.publicKey, dek)
    // epk (32) + ciphertext (32) + GCM tag (16). The nonce is derived, not
    // carried, so it costs no wire bytes.
    expect(box).toHaveLength(X25519_PUBLIC_KEY_BYTES + dek.length + 16)
  })

  it("produces a different box every time", async () => {
    use()
    const member = await generateSealingKey()
    const dek = generateAeadKey()
    const a = await seal(member.publicKey, dek)
    const b = await seal(member.publicKey, dek)
    expect(toHex(a)).not.toBe(toHex(b))
    expect(toHex(await member.open(a))).toBe(toHex(await member.open(b)))
  })

  // The property the keyring depends on: sealed copies can sit in the open
  // because a non-recipient learns nothing from one.
  it("cannot be opened by a different member", async () => {
    use()
    const member = await generateSealingKey()
    const outsider = await generateSealingKey()
    const box = await seal(member.publicKey, generateAeadKey())
    await expect(outsider.open(box)).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects a tampered ciphertext", async () => {
    use()
    const member = await generateSealingKey()
    const box = await seal(member.publicKey, generateAeadKey())
    box[box.length - 1] ^= 0x01
    await expect(member.open(box)).rejects.toThrow(/AEAD open failed/)
  })

  // Both public keys are bound into the HKDF info, so swapping the ephemeral
  // key changes the derived key and the box stops opening.
  it("rejects a substituted ephemeral public key", async () => {
    use()
    const member = await generateSealingKey()
    const box = await seal(member.publicKey, generateAeadKey())
    const other = await seal(member.publicKey, generateAeadKey())
    box.set(other.subarray(0, X25519_PUBLIC_KEY_BYTES), 0)
    await expect(member.open(box)).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects a truncated box", async () => {
    use()
    const member = await generateSealingKey()
    await expect(member.open(new Uint8Array(16))).rejects.toThrow(/truncated/)
  })

  it("binds associated data", async () => {
    use()
    const member = await generateSealingKey()
    const box = await seal(member.publicKey, generateAeadKey(), utf8("notebook:1|epoch:3"))
    await expect(member.open(box, utf8("notebook:1|epoch:4"))).rejects.toThrow(/AEAD open failed/)
    await expect(member.open(box)).rejects.toThrow(/AEAD open failed/)
  })

  it("rejects a wrong-length recipient key", async () => {
    use()
    await expect(seal(new Uint8Array(31), generateAeadKey())).rejects.toThrow(/32 bytes/)
  })

  it("round-trips an imported key and reports its backend", async () => {
    use()
    const secret = fromHex(X25519_ECDH_VECTOR.aliceSecretKey)
    const member = await importSealingKey(secret)
    expect(member.backend).toBe(backend)
    expect(toHex(member.publicKey)).toBe(X25519_ECDH_VECTOR.alicePublicKey)
    expect(toHex((await member.exportSecretKey())!)).toBe(X25519_ECDH_VECTOR.aliceSecretKey)
    const dek = generateAeadKey()
    expect(toHex(await member.open(await seal(member.publicKey, dek)))).toBe(toHex(dek))
  })
})

describe("cross-backend compatibility", () => {
  it("a box sealed under WebCrypto opens under noble and vice versa", async () => {
    const secret = fromHex(X25519_ECDH_VECTOR.bobSecretKey)
    const dek = generateAeadKey()

    setCurveBackend("webcrypto")
    const webBox = await seal(x25519PublicKey(secret), dek)
    setCurveBackend("noble")
    expect(toHex(await (await importSealingKey(secret)).open(webBox))).toBe(toHex(dek))

    const nobleBox = await seal(x25519PublicKey(secret), dek)
    setCurveBackend("webcrypto")
    expect(toHex(await (await importSealingKey(secret)).open(nobleBox))).toBe(toHex(dek))
  })
})

describe("non-extractable sealing keys", () => {
  it("refuses to hand back a WebCrypto private key but still opens boxes", async () => {
    setCurveBackend("webcrypto")
    const member = await generateSealingKey()
    expect(member.extractable).toBe(false)
    expect(await member.exportSecretKey()).toBeNull()
    const dek = generateAeadKey()
    expect(toHex(await member.open(await seal(member.publicKey, dek)))).toBe(toHex(dek))
  })
})
