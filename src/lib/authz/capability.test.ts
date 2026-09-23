import { describe, expect, it } from "vitest"
import { fromBase64Url, generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSealingKey, didFromSigningKey } from "@/lib/identity"
import { generateSealingKey } from "@/lib/crypto"
import {
  CAPABILITY_VERSION,
  capabilityCid,
  decodeCapability,
  issueCapability,
  isTimeValid,
  verifyCapabilitySignature,
  type Capability,
} from "./capability"

const RESOURCE = "notebook:1"
const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function principal(): Promise<{ key: SigningKey; did: string }> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

async function issue(overrides: Partial<Parameters<typeof issueCapability>[0]> = {}) {
  const issuer = await principal()
  const audience = await principal()
  const capability = await issueCapability({
    signingKey: issuer.key,
    issuer: issuer.did,
    audience: audience.did,
    resource: RESOURCE,
    ability: "write",
    notBefore: T0,
    expiresAt: T0 + DAY,
    ...overrides,
  })
  return { issuer, audience, capability }
}

describe("issueCapability", () => {
  it("records every field of the grant", async () => {
    const { issuer, audience, capability } = await issue({ ability: "admin", depth: 2 })

    expect(capability.payload.iss).toBe(issuer.did)
    expect(capability.payload.aud).toBe(audience.did)
    expect(capability.payload.rsc).toBe(RESOURCE)
    expect(capability.payload.can).toBe("admin")
    expect(capability.payload.dep).toBe(2)
    expect(capability.payload.prf).toBeNull()
    expect(capability.header.ucv).toBe(CAPABILITY_VERSION)
  })

  // A leaf is non-delegable unless the issuer says otherwise.
  it("defaults to a non-delegable leaf", async () => {
    const { capability } = await issue()
    expect(capability.payload.dep).toBe(0)
  })

  it("verifies under the issuer's key", async () => {
    const { capability } = await issue()
    expect(await verifyCapabilitySignature(capability)).toBe(true)
  })

  it("refuses an issuer that did not sign", async () => {
    const issuer = await principal()
    const other = await principal()
    await expect(
      issueCapability({
        signingKey: issuer.key,
        issuer: other.did,
        audience: other.did,
        resource: RESOURCE,
        ability: "read",
        expiresAt: T0 + DAY,
        notBefore: T0,
      }),
    ).rejects.toThrow(/does not match the supplied signing key/)
  })

  // A sealing key is not a principal - only signing keys can be an audience.
  it("refuses a sealing DID as the audience", async () => {
    const issuer = await principal()
    const sealing = await generateSealingKey()
    await expect(
      issueCapability({
        signingKey: issuer.key,
        issuer: issuer.did,
        audience: didFromSealingKey(sealing.publicKey),
        resource: RESOURCE,
        ability: "read",
        expiresAt: T0 + DAY,
        notBefore: T0,
      }),
    ).rejects.toThrow(/expected a ed25519 did:key/)
  })

  it("refuses a negative depth and a backwards validity window", async () => {
    const issuer = await principal()
    const base = {
      signingKey: issuer.key,
      issuer: issuer.did,
      audience: issuer.did,
      resource: RESOURCE,
      ability: "read" as const,
      notBefore: T0,
    }
    await expect(issueCapability({ ...base, depth: -1, expiresAt: T0 + DAY })).rejects.toThrow(
      /non-negative integer/,
    )
    await expect(issueCapability({ ...base, expiresAt: T0 })).rejects.toThrow(
      /expiry must be after its start/,
    )
  })

  // Two otherwise identical grants must be distinguishable.
  it("gives identical grants distinct ids", async () => {
    const issuer = await principal()
    const audience = await principal()
    const options = {
      signingKey: issuer.key,
      issuer: issuer.did,
      audience: audience.did,
      resource: RESOURCE,
      ability: "read" as const,
      notBefore: T0,
      expiresAt: T0 + DAY,
    }
    const first = await issueCapability(options)
    const second = await issueCapability(options)
    expect(first.cid).not.toBe(second.cid)
  })
})

describe("JWT-compact encoding", () => {
  it("is three base64url segments", async () => {
    const { capability } = await issue()
    const parts = capability.token.split(".")
    expect(parts).toHaveLength(3)
    expect(capability.token).not.toMatch(/[+/=]/)
    for (const part of parts) expect(() => fromBase64Url(part)).not.toThrow()
  })

  it("round-trips through decode", async () => {
    const { capability } = await issue({ ability: "admin", depth: 3 })
    const decoded = await decodeCapability(capability.token)

    expect(decoded.payload).toEqual(capability.payload)
    expect(decoded.cid).toBe(capability.cid)
    expect(await verifyCapabilitySignature(decoded)).toBe(true)
  })

  it("derives the cid from the token alone", async () => {
    const { capability } = await issue()
    expect(await capabilityCid(capability.token)).toBe(capability.cid)
  })

  it("rejects malformed tokens", async () => {
    await expect(decodeCapability("one.two")).rejects.toThrow(/three segments/)
    await expect(decodeCapability("!!!.!!!.!!!")).rejects.toThrow(/base64url JSON/)
  })

  it("rejects an unsupported header or version", async () => {
    const { capability } = await issue()
    const parts = capability.token.split(".")
    const badAlg = `${btoa(JSON.stringify({ alg: "RS256", typ: "JWT", ucv: CAPABILITY_VERSION }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${parts[1]}.${parts[2]}`
    await expect(decodeCapability(badAlg)).rejects.toThrow(/unsupported capability header/)
  })

  it("rejects a payload missing required fields", async () => {
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT", ucv: CAPABILITY_VERSION }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const payload = btoa(JSON.stringify({ iss: "did:key:zA" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    await expect(decodeCapability(`${header}.${payload}.AAAA`)).rejects.toThrow(/malformed/)
  })
})

describe("verifyCapabilitySignature", () => {
  it("rejects a tampered signature segment", async () => {
    const { capability } = await issue()
    const parts = capability.token.split(".")
    const tampered: Capability = { ...capability, token: `${parts[0]}.${parts[1]}.AAAA` }
    expect(await verifyCapabilitySignature(tampered)).toBe(false)
  })

  // The token is canonical; a payload view that disagrees with it must not be
  // trusted, or the chain walk would read an escalation nobody signed.
  it("rejects a payload that disagrees with the signed token", async () => {
    const { capability } = await issue({ ability: "read" })
    for (const field of ["can", "aud", "rsc", "dep", "exp"] as const) {
      const value = field === "dep" || field === "exp" ? 99 : "tampered"
      const forged = {
        ...capability,
        payload: { ...capability.payload, [field]: value },
      } as Capability
      expect(await verifyCapabilitySignature(forged)).toBe(false)
    }
  })

  it("returns false rather than throwing on nonsense", async () => {
    expect(await verifyCapabilitySignature({ token: "x" } as Capability)).toBe(false)
    expect(await verifyCapabilitySignature({} as Capability)).toBe(false)
  })
})

describe("isTimeValid", () => {
  it("is inclusive of nbf and exclusive of exp", async () => {
    const { capability } = await issue()
    expect(isTimeValid(capability.payload, T0 - 1)).toBe(false)
    expect(isTimeValid(capability.payload, T0)).toBe(true)
    expect(isTimeValid(capability.payload, T0 + DAY - 1)).toBe(true)
    expect(isTimeValid(capability.payload, T0 + DAY)).toBe(false)
  })
})
