import { describe, expect, it } from "vitest"
import {
  generateSealingKey,
  generateSigningKey,
  toBase64Url,
  toHex,
  type SealingKey,
  type SigningKey,
} from "@/lib/crypto"
import { deriveClientId } from "./client-id"
import {
  canonicalBytes,
  createDeviceRecord,
  DEVICE_RECORD_VERSION,
  sealingPublicKeyOf,
  signingPublicKeyOf,
  verifyDeviceRecord,
  type DeviceRecord,
} from "./device-record"

async function newDevice(): Promise<{
  signingKey: SigningKey
  sealingKey: SealingKey
  record: DeviceRecord
}> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey, { createdAt: 1_700_000_000_000 })
  return { signingKey, sealingKey, record }
}

describe("createDeviceRecord", () => {
  it("names both keys and the derived client id", async () => {
    const { signingKey, sealingKey, record } = await newDevice()
    expect(record.v).toBe(DEVICE_RECORD_VERSION)
    expect(record.did).toMatch(/^did:key:z6Mk/)
    expect(record.sealingDid).toMatch(/^did:key:z6LS/)
    expect(record.clientId).toBe(await deriveClientId(signingKey.publicKey))
    expect(toHex(signingPublicKeyOf(record))).toBe(toHex(signingKey.publicKey))
    expect(toHex(sealingPublicKeyOf(record))).toBe(toHex(sealingKey.publicKey))
  })

  it("verifies", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord(record)).toBe(true)
  })

  it("survives a JSON round trip", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord(JSON.parse(JSON.stringify(record)) as DeviceRecord)).toBe(true)
  })
})

describe("canonicalBytes", () => {
  it("is insensitive to property order", async () => {
    const { record } = await newDevice()
    const body = { v: record.v, did: record.did, sealingDid: record.sealingDid, clientId: record.clientId, createdAt: record.createdAt }
    const reordered = {
      createdAt: body.createdAt,
      clientId: body.clientId,
      sealingDid: body.sealingDid,
      did: body.did,
      v: body.v,
    }
    expect(toHex(canonicalBytes(reordered))).toBe(toHex(canonicalBytes(body)))
  })

  it("changes when any field changes", async () => {
    const { record } = await newDevice()
    const body = { v: record.v, did: record.did, sealingDid: record.sealingDid, clientId: record.clientId, createdAt: record.createdAt }
    const base = toHex(canonicalBytes(body))
    expect(toHex(canonicalBytes({ ...body, clientId: body.clientId + 1 }))).not.toBe(base)
    expect(toHex(canonicalBytes({ ...body, createdAt: body.createdAt + 1 }))).not.toBe(base)
  })
})

describe("verifyDeviceRecord rejection", () => {
  it("rejects a tampered signature", async () => {
    const { record } = await newDevice()
    const bad = { ...record, sig: toBase64Url(new Uint8Array(64)) }
    expect(await verifyDeviceRecord(bad)).toBe(false)
  })

  it("rejects a tampered createdAt", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord({ ...record, createdAt: record.createdAt + 1 })).toBe(false)
  })

  // The attribution forgery this record format exists to stop: claiming a
  // client id that the device's own key does not derive.
  it("rejects a record claiming a client id it is not entitled to", async () => {
    const { record } = await newDevice()
    const forged = { ...record, clientId: record.clientId + 1 }
    expect(await verifyDeviceRecord(forged)).toBe(false)
  })

  it("rejects a record whose signing DID was swapped for another device's", async () => {
    const mine = await newDevice()
    const theirs = await newDevice()
    expect(await verifyDeviceRecord({ ...mine.record, did: theirs.record.did })).toBe(false)
  })

  it("rejects a sealing DID swapped in from another device", async () => {
    const mine = await newDevice()
    const theirs = await newDevice()
    // Signature no longer covers the substituted key, so this fails even though
    // both DIDs are individually well formed.
    expect(
      await verifyDeviceRecord({ ...mine.record, sealingDid: theirs.record.sealingDid }),
    ).toBe(false)
  })

  it("rejects a signing DID in the sealing slot", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord({ ...record, sealingDid: record.did })).toBe(false)
  })

  it("rejects an unknown version", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord({ ...record, v: 2 as 1 })).toBe(false)
  })

  it("returns false rather than throwing on malformed input", async () => {
    const { record } = await newDevice()
    expect(await verifyDeviceRecord({ ...record, did: "not-a-did" })).toBe(false)
    expect(await verifyDeviceRecord({ ...record, sig: "!!!not-base64!!!" })).toBe(false)
    expect(await verifyDeviceRecord({} as DeviceRecord)).toBe(false)
  })
})
