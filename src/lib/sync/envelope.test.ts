import { describe, expect, it } from "vitest"
import { generateAeadKey, generateSigningKey, toHex, utf8 } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  envelopeHeader,
  headerBytes,
  isEnvelopeShaped,
  makeEnvelope,
  openEnvelope,
  verifyEnvelopeSignature,
  type Envelope,
} from "./envelope"

const RESOURCE = "notebook:1"

async function sealed(overrides: Partial<Parameters<typeof makeEnvelope>[0]> = {}) {
  const signingKey = await generateSigningKey()
  const dek = generateAeadKey()
  const envelope = await makeEnvelope({
    signingKey,
    author: didFromSigningKey(signingKey.publicKey),
    seq: 1,
    resourceId: RESOURCE,
    epoch: 1,
    dek,
    update: utf8("a yjs update"),
    ...overrides,
  })
  return { signingKey, dek, envelope }
}

describe("makeEnvelope", () => {
  it("round-trips the payload", async () => {
    const { dek, envelope } = await sealed()
    expect(toHex(await openEnvelope(envelope, dek))).toBe(toHex(utf8("a yjs update")))
  })

  it("verifies under the author's key", async () => {
    const { signingKey, envelope } = await sealed()
    expect(await verifyEnvelopeSignature(envelope, signingKey.publicKey)).toBe(true)
  })

  it("defaults to an update and records the kind in the header", async () => {
    const { envelope } = await sealed()
    expect(envelope.kind).toBe("update")
    expect(envelopeHeader(envelope).kind).toBe("update")
  })

  it("rejects a non-positive sequence", async () => {
    await expect(sealed({ seq: 0 })).rejects.toThrow(/positive integer/)
    await expect(sealed({ seq: -1 })).rejects.toThrow(/positive integer/)
  })

  it("is JSON-serialisable end to end", async () => {
    const { dek, envelope } = await sealed()
    const revived = JSON.parse(JSON.stringify(envelope)) as Envelope
    expect(toHex(await openEnvelope(revived, dek))).toBe(toHex(utf8("a yjs update")))
  })
})

// Every header field is both signed and bound as the AEAD's associated data,
// so a ciphertext cannot be lifted into an envelope that claims anything else.
describe("the header is bound to the ciphertext", () => {
  const fields = [
    ["author", "did:key:z6MkSomeoneElse"],
    ["seq", 99],
    ["resourceId", "notebook:other"],
    ["epoch", 7],
    ["kind", "presence"],
  ] as const

  it.each(fields)("breaks the signature when %s is changed", async (field, value) => {
    const { signingKey, envelope } = await sealed()
    const tampered = { ...envelope, [field]: value } as Envelope
    expect(await verifyEnvelopeSignature(tampered, signingKey.publicKey)).toBe(false)
  })

  it.each(fields)("breaks decryption when %s is changed", async (field, value) => {
    const { dek, envelope } = await sealed()
    const tampered = { ...envelope, [field]: value } as Envelope
    await expect(openEnvelope(tampered, dek)).rejects.toThrow(/AEAD open failed/)
  })

  it("distinguishes the two kinds in the signed bytes", async () => {
    const { envelope } = await sealed()
    const asPresence = { ...envelopeHeader(envelope), kind: "presence" as const }
    expect(toHex(headerBytes(envelopeHeader(envelope)))).not.toBe(toHex(headerBytes(asPresence)))
  })
})

describe("verifyEnvelopeSignature rejection", () => {
  it("rejects the wrong key, a tampered ciphertext and a bad nonce", async () => {
    const { signingKey, envelope } = await sealed()
    const other = await generateSigningKey()

    expect(await verifyEnvelopeSignature(envelope, other.publicKey)).toBe(false)
    expect(
      await verifyEnvelopeSignature({ ...envelope, ct: "AAAA" }, signingKey.publicKey),
    ).toBe(false)
    expect(
      await verifyEnvelopeSignature({ ...envelope, nonce: "AAAA" }, signingKey.publicKey),
    ).toBe(false)
  })

  it("returns false rather than throwing on nonsense", async () => {
    const { signingKey } = await sealed()
    expect(await verifyEnvelopeSignature({} as Envelope, signingKey.publicKey)).toBe(false)
    expect(
      await verifyEnvelopeSignature({ v: 2 } as unknown as Envelope, signingKey.publicKey),
    ).toBe(false)
  })
})

describe("isEnvelopeShaped", () => {
  it("accepts both kinds and rejects anything else", async () => {
    const { envelope } = await sealed()
    expect(isEnvelopeShaped(envelope)).toBe(true)
    expect(isEnvelopeShaped({ ...envelope, kind: "presence" })).toBe(true)
    expect(isEnvelopeShaped({ ...envelope, kind: "awareness" })).toBe(false)
    expect(isEnvelopeShaped({ ...envelope, kind: undefined })).toBe(false)
    expect(isEnvelopeShaped(null)).toBe(false)
    expect(isEnvelopeShaped({})).toBe(false)
  })
})
