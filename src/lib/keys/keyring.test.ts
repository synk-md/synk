import { describe, expect, it } from "vitest"
import { generateAeadKey, toBase64Url, toHex } from "@/lib/crypto"
import { newMember, NOTEBOOK } from "@/test/key-fixtures"
import { openEpochKey, openKeyring, sealEpochKey, type SealedEpochKey } from "./keyring"

describe("sealEpochKey / openEpochKey", () => {
  it("round-trips to its recipient", async () => {
    const alice = await newMember("alice")
    const key = generateAeadKey()
    const sealed = await sealEpochKey(NOTEBOOK, 3, alice.sealingDid, key)

    expect(sealed.domain).toBe(NOTEBOOK)
    expect(sealed.epoch).toBe(3)
    expect(sealed.recipient).toBe(alice.sealingDid)
    expect(toHex(await openEpochKey(sealed, alice.sealingKey))).toBe(toHex(key))
  })

  it("cannot be opened by anyone else", async () => {
    const alice = await newMember("alice")
    const mallory = await newMember("mallory")
    const sealed = await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, generateAeadKey())
    await expect(openEpochKey(sealed, mallory.sealingKey)).rejects.toThrow(/AEAD open failed/)
  })

  // Domain, epoch and recipient are the associated data, so a copy cannot be
  // re-labelled as the key for something else.
  it("cannot be re-addressed or relabelled", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const sealed = await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, generateAeadKey())

    for (const tampered of [
      { ...sealed, epoch: 2 },
      { ...sealed, domain: "notebook:other" },
      { ...sealed, recipient: bob.sealingDid },
    ]) {
      await expect(openEpochKey(tampered, alice.sealingKey)).rejects.toThrow(/AEAD open failed/)
    }
  })

  it("rejects a tampered box and an unknown version", async () => {
    const alice = await newMember("alice")
    const sealed = await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, generateAeadKey())

    await expect(
      openEpochKey({ ...sealed, box: toBase64Url(new Uint8Array(64)) }, alice.sealingKey),
    ).rejects.toThrow()
    await expect(
      openEpochKey({ ...sealed, v: 2 as 1 }, alice.sealingKey),
    ).rejects.toThrow(/unsupported sealed epoch key version/)
  })

  it("refuses a signing DID as a recipient", async () => {
    await expect(
      sealEpochKey(NOTEBOOK, 1, "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", generateAeadKey()),
    ).rejects.toThrow(/expected a x25519 did:key/)
  })
})

describe("openKeyring", () => {
  it("picks out only this member's copies", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const keys = [generateAeadKey(), generateAeadKey()]

    const keyring: SealedEpochKey[] = [
      await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, keys[0]),
      await sealEpochKey(NOTEBOOK, 1, bob.sealingDid, keys[0]),
      await sealEpochKey(NOTEBOOK, 2, alice.sealingDid, keys[1]),
      await sealEpochKey("notebook:other", 1, alice.sealingDid, generateAeadKey()),
    ]

    const { anchors, skipped, failed } = await openKeyring(
      keyring,
      NOTEBOOK,
      alice.sealingDid,
      alice.sealingKey,
    )
    expect([...anchors.keys()].sort()).toEqual([1, 2])
    expect(toHex(anchors.get(1)!)).toBe(toHex(keys[0]))
    expect(skipped).toBe(2)
    expect(failed).toBe(0)
  })

  // A keyring read from shared state contains copies for everyone, and a
  // hostile peer can add junk. Neither may throw.
  it("counts failures instead of throwing", async () => {
    const alice = await newMember("alice")
    const good = await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, generateAeadKey())
    const corrupt = { ...good, epoch: 5, box: toBase64Url(new Uint8Array(80)) }

    const { anchors, failed } = await openKeyring(
      [good, corrupt, null as unknown as SealedEpochKey],
      NOTEBOOK,
      alice.sealingDid,
      alice.sealingKey,
    )
    expect([...anchors.keys()]).toEqual([1])
    expect(failed).toBe(1)
  })

  it("returns nothing for a member with no copies", async () => {
    const stranger = await newMember("stranger")
    const alice = await newMember("alice")
    const { anchors } = await openKeyring(
      [await sealEpochKey(NOTEBOOK, 1, alice.sealingDid, generateAeadKey())],
      NOTEBOOK,
      stranger.sealingDid,
      stranger.sealingKey,
    )
    expect(anchors.size).toBe(0)
  })
})
