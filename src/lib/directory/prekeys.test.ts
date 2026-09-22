import { describe, expect, it } from "vitest"
import { generateSealingKey, toBase64Url } from "@/lib/crypto"
import { didFromSealingKey, didFromSigningKey } from "@/lib/identity"
import { newDevice } from "@/test/identity-fixtures"
import {
  DEFAULT_PREKEY_TTL_MS,
  PREKEY_BUNDLE_VERSION,
  prekeyBundleBytes,
  publishPrekeys,
  remainingOneTimePrekeys,
  selectSealingTarget,
  verifyPrekeyBundle,
  type PrekeyBundle,
} from "./prekeys"

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function sealingDid(): Promise<string> {
  return didFromSealingKey((await generateSealingKey()).publicKey)
}

async function bundleFor(
  device: Awaited<ReturnType<typeof newDevice>>,
  oneTimeCount = 3,
): Promise<PrekeyBundle> {
  const oneTimePrekeys: string[] = []
  for (let i = 0; i < oneTimeCount; i += 1) oneTimePrekeys.push(await sealingDid())
  return publishPrekeys({
    signingKey: device.key,
    record: device.record,
    signedPrekey: await sealingDid(),
    oneTimePrekeys,
    publishedAt: T0,
  })
}

describe("publishPrekeys", () => {
  it("publishes a signed bundle under the device's own DID", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)

    expect(bundle.v).toBe(PREKEY_BUNDLE_VERSION)
    expect(bundle.did).toBe(device.record.did)
    expect(bundle.oneTimePrekeys).toHaveLength(3)
    expect(bundle.expiresAt).toBe(T0 + DEFAULT_PREKEY_TTL_MS)
    expect(await verifyPrekeyBundle(bundle, { now: T0 })).toBe(true)
  })

  it("works with no one-time keys at all", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device, 0)
    expect(bundle.oneTimePrekeys).toEqual([])
    expect(await verifyPrekeyBundle(bundle, { now: T0 })).toBe(true)
  })

  // A prekey is a claim about where to seal to a device, so only that device
  // may make it.
  it("refuses to publish under another device's record", async () => {
    const device = await newDevice()
    const other = await newDevice()
    await expect(
      publishPrekeys({
        signingKey: device.key,
        record: other.record,
        signedPrekey: await sealingDid(),
      }),
    ).rejects.toThrow(/does not match the supplied signing key/)
  })

  // A signing DID here would produce a bundle nobody can seal to, discovered
  // only at decryption time.
  it("refuses a signing DID where a sealing key belongs", async () => {
    const device = await newDevice()
    const signingDid = didFromSigningKey(device.key.publicKey)

    await expect(
      publishPrekeys({ signingKey: device.key, record: device.record, signedPrekey: signingDid }),
    ).rejects.toThrow(/expected a x25519 did:key/)

    await expect(
      publishPrekeys({
        signingKey: device.key,
        record: device.record,
        signedPrekey: await sealingDid(),
        oneTimePrekeys: [signingDid],
      }),
    ).rejects.toThrow(/expected a x25519 did:key/)
  })

  it("refuses duplicate one-time keys", async () => {
    const device = await newDevice()
    const duplicate = await sealingDid()
    await expect(
      publishPrekeys({
        signingKey: device.key,
        record: device.record,
        signedPrekey: await sealingDid(),
        oneTimePrekeys: [duplicate, duplicate],
      }),
    ).rejects.toThrow(/must be distinct/)
  })
})

describe("verifyPrekeyBundle", () => {
  it("rejects tampering with any published key", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)
    const intruder = await sealingDid()

    expect(await verifyPrekeyBundle({ ...bundle, signedPrekey: intruder }, { now: T0 })).toBe(false)
    expect(
      await verifyPrekeyBundle({ ...bundle, oneTimePrekeys: [intruder] }, { now: T0 }),
    ).toBe(false)
    expect(
      await verifyPrekeyBundle(
        { ...bundle, oneTimePrekeys: [...bundle.oneTimePrekeys, intruder] },
        { now: T0 },
      ),
    ).toBe(false)
  })

  it("rejects a bundle re-attributed to another device", async () => {
    const device = await newDevice()
    const other = await newDevice()
    const bundle = await bundleFor(device)
    expect(await verifyPrekeyBundle({ ...bundle, did: other.record.did }, { now: T0 })).toBe(false)
  })

  it("rejects a tampered signature, version and expiry", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)

    expect(
      await verifyPrekeyBundle({ ...bundle, sig: toBase64Url(new Uint8Array(64)) }, { now: T0 }),
    ).toBe(false)
    expect(await verifyPrekeyBundle({ ...bundle, v: 2 as 1 }, { now: T0 })).toBe(false)
    expect(
      await verifyPrekeyBundle({ ...bundle, expiresAt: T0 + 999 * DAY }, { now: T0 }),
    ).toBe(false)
  })

  it("expires, unless explicitly inspecting history", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)
    const afterExpiry = bundle.expiresAt + 1

    expect(await verifyPrekeyBundle(bundle, { now: afterExpiry })).toBe(false)
    expect(await verifyPrekeyBundle(bundle, { now: afterExpiry, allowExpired: true })).toBe(true)
  })

  it("returns false rather than throwing on malformed input", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)
    expect(await verifyPrekeyBundle({ ...bundle, signedPrekey: "nope" }, { now: T0 })).toBe(false)
    expect(
      await verifyPrekeyBundle({ ...bundle, oneTimePrekeys: null as unknown as string[] }, {
        now: T0,
      }),
    ).toBe(false)
    expect(await verifyPrekeyBundle({} as PrekeyBundle, { now: T0 })).toBe(false)
  })
})

describe("prekeyBundleBytes", () => {
  it("distinguishes different pools", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)
    const body = {
      v: bundle.v,
      did: bundle.did,
      signedPrekey: bundle.signedPrekey,
      oneTimePrekeys: bundle.oneTimePrekeys,
      publishedAt: bundle.publishedAt,
      expiresAt: bundle.expiresAt,
    }
    expect(toBase64Url(prekeyBundleBytes({ ...body, oneTimePrekeys: [] }))).not.toBe(
      toBase64Url(prekeyBundleBytes(body)),
    )
    expect(
      toBase64Url(
        prekeyBundleBytes({ ...body, oneTimePrekeys: [...body.oneTimePrekeys].reverse() }),
      ),
    ).not.toBe(toBase64Url(prekeyBundleBytes(body)))
  })
})

describe("selectSealingTarget", () => {
  it("prefers an unconsumed one-time key", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)

    const target = selectSealingTarget(bundle)
    expect(target.kind).toBe("one-time")
    expect(bundle.oneTimePrekeys).toContain(target.prekey)
  })

  it("walks the pool as keys are consumed", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)
    const consumed: string[] = []

    for (let i = 0; i < bundle.oneTimePrekeys.length; i += 1) {
      const target = selectSealingTarget(bundle, consumed)
      expect(target.kind).toBe("one-time")
      expect(consumed).not.toContain(target.prekey)
      consumed.push(target.prekey)
    }
    expect(remainingOneTimePrekeys(bundle, consumed)).toBe(0)
  })

  // Addition must never block on the pool being empty.
  it("falls back to the signed prekey once the pool is spent", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device)

    const target = selectSealingTarget(bundle, bundle.oneTimePrekeys)
    expect(target.kind).toBe("signed")
    expect(target.prekey).toBe(bundle.signedPrekey)
  })

  it("falls back immediately when no pool was published", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device, 0)
    expect(selectSealingTarget(bundle)).toEqual({
      prekey: bundle.signedPrekey,
      kind: "signed",
    })
  })
})

describe("remainingOneTimePrekeys", () => {
  it("counts what is left, for deciding when to republish", async () => {
    const device = await newDevice()
    const bundle = await bundleFor(device, 3)
    expect(remainingOneTimePrekeys(bundle)).toBe(3)
    expect(remainingOneTimePrekeys(bundle, [bundle.oneTimePrekeys[0]])).toBe(2)
    expect(remainingOneTimePrekeys(bundle, bundle.oneTimePrekeys)).toBe(0)
  })
})
