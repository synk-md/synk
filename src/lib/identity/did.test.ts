import { describe, expect, it } from "vitest"
import { base58 } from "@scure/base"
import { generateSealingKey, generateSigningKey, toHex } from "@/lib/crypto"
import {
  decodeDid,
  didFromSealingKey,
  didFromSigningKey,
  isValidDid,
  publicKeyFromDid,
} from "./did"

// Published did:key identifiers from the W3C did:key specification fixtures.
// These pin the multicodec prefixes and the base58btc alphabet: an Ed25519 DID
// must render as z6Mk..., an X25519 one as z6LS.... Getting either wrong would
// still round-trip against ourselves, which is exactly why these are here.
const SPEC_DIDS = {
  ed25519: [
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
  ],
  x25519: ["did:key:z6LSeu9HkTHSfLLeUs2nnzUSNedgDUevfNQgQjQC23ZCit6F"],
} as const

describe("did:key spec vectors", () => {
  it.each(SPEC_DIDS.ed25519)("decodes %s as ed25519 and re-encodes identically", (did) => {
    const decoded = decodeDid(did)
    expect(decoded.type).toBe("ed25519")
    expect(decoded.publicKey).toHaveLength(32)
    expect(didFromSigningKey(decoded.publicKey)).toBe(did)
  })

  it.each(SPEC_DIDS.x25519)("decodes %s as x25519 and re-encodes identically", (did) => {
    const decoded = decodeDid(did)
    expect(decoded.type).toBe("x25519")
    expect(didFromSealingKey(decoded.publicKey)).toBe(did)
  })

  it("renders the documented human-readable prefixes", async () => {
    const signing = await generateSigningKey()
    const sealing = await generateSealingKey()
    expect(didFromSigningKey(signing.publicKey)).toMatch(/^did:key:z6Mk/)
    expect(didFromSealingKey(sealing.publicKey)).toMatch(/^did:key:z6LS/)
  })
})

describe("round trip", () => {
  it("preserves real generated keys", async () => {
    const signing = await generateSigningKey()
    const did = didFromSigningKey(signing.publicKey)
    expect(toHex(publicKeyFromDid(did, "ed25519"))).toBe(toHex(signing.publicKey))
  })
})

describe("decodeDid rejection", () => {
  const valid = SPEC_DIDS.ed25519[0]

  it("rejects a non-did:key string", () => {
    expect(() => decodeDid("did:web:example.com")).toThrow(/not a did:key/)
    expect(() => decodeDid(valid.replace("did:key:", ""))).toThrow(/not a did:key/)
  })

  it("rejects a non-base58btc multibase", () => {
    expect(() => decodeDid("did:key:mAAAA")).toThrow(/base58btc/)
  })

  it("rejects payloads that are not valid base58", () => {
    // 0, O, I and l are outside the base58btc alphabet.
    expect(() => decodeDid("did:key:z0OIl")).toThrow(/base58btc/)
  })

  it("rejects a wrong-length payload", () => {
    expect(() => decodeDid("did:key:z6Mkha")).toThrow(/34 bytes/)
  })

  it("rejects an unsupported multicodec", () => {
    // secp256k1 (0xe7 0x01) is a real did:key codec we deliberately do not
    // support. Built properly so the failure is the codec check, not a length
    // or base58 error tripping first.
    const publicKey = decodeDid(valid).publicKey
    const payload = new Uint8Array(34)
    payload.set([0xe7, 0x01], 0)
    payload.set(publicKey, 2)
    const did = "did:key:z" + base58.encode(payload)
    expect(() => decodeDid(did)).toThrow(/unsupported multicodec/)
  })
})

describe("publicKeyFromDid type enforcement", () => {
  // The important one: an X25519 key must never be accepted where a signing
  // key belongs, or a device could be attributed edits it cannot make.
  it("refuses a sealing DID where a signing key is expected", () => {
    expect(() => publicKeyFromDid(SPEC_DIDS.x25519[0], "ed25519")).toThrow(
      /expected a ed25519 did:key, got x25519/,
    )
  })

  it("refuses a signing DID where a sealing key is expected", () => {
    expect(() => publicKeyFromDid(SPEC_DIDS.ed25519[0], "x25519")).toThrow(
      /expected a x25519 did:key, got ed25519/,
    )
  })
})

describe("isValidDid", () => {
  it("is a non-throwing check", () => {
    expect(isValidDid(SPEC_DIDS.ed25519[0])).toBe(true)
    expect(isValidDid(SPEC_DIDS.ed25519[0], "ed25519")).toBe(true)
    expect(isValidDid(SPEC_DIDS.ed25519[0], "x25519")).toBe(false)
    expect(isValidDid("nonsense")).toBe(false)
  })
})

describe("encoding rejection", () => {
  it("refuses a wrong-length public key", () => {
    expect(() => didFromSigningKey(new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => didFromSealingKey(new Uint8Array(33))).toThrow(/32 bytes/)
  })
})
