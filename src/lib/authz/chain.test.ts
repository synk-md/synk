import { describe, expect, it } from "vitest"
import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  issueCapability,
  verifyCapabilitySignature,
  type Ability,
  type Capability,
} from "./capability"
import { authorize, MAX_CHAIN_DEPTH, verifyChain, type AuthorizationContext } from "./chain"
import { revokeCapability } from "./revocation"
import { CapabilityStore } from "./store"

const RESOURCE = "notebook:1"
const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

interface Principal {
  key: SigningKey
  did: string
}

async function principal(): Promise<Principal> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

async function grant(
  issuer: Principal,
  audience: Principal,
  options: {
    ability?: Ability
    resource?: string
    depth?: number
    proof?: string | null
    notBefore?: number
    expiresAt?: number
  } = {},
): Promise<Capability> {
  return issueCapability({
    signingKey: issuer.key,
    issuer: issuer.did,
    audience: audience.did,
    resource: options.resource ?? RESOURCE,
    ability: options.ability ?? "write",
    depth: options.depth ?? 0,
    proof: options.proof ?? null,
    notBefore: options.notBefore ?? T0,
    expiresAt: options.expiresAt ?? T0 + 24 * HOUR,
  })
}

function context(owner: string, capabilities: Capability[], now = T0): AuthorizationContext {
  return {
    proofs: new Map(capabilities.map((c) => [c.cid, c])),
    owner,
    now,
  }
}

describe("the chain walk reaches the owner", () => {
  it("authorizes a direct grant from the owner", async () => {
    const owner = await principal()
    const writer = await principal()
    const root = await grant(owner, writer)

    const result = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      context(owner.did, [root]),
    )
    expect(result.authorized).toBe(true)
    expect(result.chain).toHaveLength(1)
  })

  // Not hard-coded to owner-to-member: the walk is depth-agnostic.
  it("authorizes through an arbitrary-depth chain", async () => {
    const owner = await principal()
    const admin = await principal()
    const lead = await principal()
    const writer = await principal()

    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 3 })
    const toLead = await grant(admin, lead, { ability: "admin", depth: 2, proof: toAdmin.cid })
    const toWriter = await grant(lead, writer, { ability: "write", depth: 0, proof: toLead.cid })

    const result = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      context(owner.did, [toAdmin, toLead, toWriter]),
    )
    expect(result.authorized).toBe(true)
    // Root first, so a caller can show where authority came from.
    expect(result.chain?.map((c) => c.payload.aud)).toEqual([admin.did, lead.did, writer.did])
  })

  // The single place ownership enters the model.
  it("rejects a chain whose root was not issued by the owner", async () => {
    const owner = await principal()
    const impostor = await principal()
    const writer = await principal()
    const root = await grant(impostor, writer, { ability: "admin", depth: 1 })

    const result = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      context(owner.did, [root]),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("root-not-owner")
  })

  it("rejects when a proof is unavailable", async () => {
    const owner = await principal()
    const admin = await principal()
    const writer = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 2 })
    const toWriter = await grant(admin, writer, { proof: toAdmin.cid })

    // The parent is deliberately not in the proof set.
    const result = await verifyChain(toWriter, context(owner.did, [toWriter]))
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("broken-proof")
  })
})

describe("attenuation is enforced at every link", () => {
  it("refuses an escalation of ability", async () => {
    const owner = await principal()
    const writer = await principal()
    const other = await principal()
    const toWriter = await grant(owner, writer, { ability: "write", depth: 1 })
    // A writer trying to hand on admin.
    const escalated = await grant(writer, other, { ability: "admin", proof: toWriter.cid })

    const result = await verifyChain(escalated, context(owner.did, [toWriter, escalated]))
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("attenuation")
    expect(result.detail).toContain("ability")
  })

  it("refuses widening the resource", async () => {
    const owner = await principal()
    const admin = await principal()
    const other = await principal()
    const narrow = await grant(owner, admin, {
      ability: "admin",
      depth: 1,
      resource: "notebook:1/note:abc",
    })
    const widened = await grant(admin, other, {
      ability: "write",
      resource: "notebook:1",
      proof: narrow.cid,
    })

    const result = await verifyChain(widened, context(owner.did, [narrow, widened]))
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("resource")
  })

  // A leaf is non-delegable by default, which is what "depth 0" means.
  it("refuses delegation from a leaf", async () => {
    const owner = await principal()
    const writer = await principal()
    const other = await principal()
    const leaf = await grant(owner, writer, { depth: 0 })
    const onward = await grant(writer, other, { proof: leaf.cid })

    const result = await verifyChain(onward, context(owner.did, [leaf, onward]))
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("non-delegable leaf")
  })

  it("refuses a child claiming more remaining depth than its parent has", async () => {
    const owner = await principal()
    const admin = await principal()
    const other = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 1 })
    // Parent has 1 left, so a child may have at most 0.
    const greedy = await grant(admin, other, { depth: 1, proof: toAdmin.cid })

    const result = await verifyChain(greedy, context(owner.did, [toAdmin, greedy]))
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("depth")
  })

  it("refuses validity outside its proof's window", async () => {
    const owner = await principal()
    const admin = await principal()
    const other = await principal()
    const toAdmin = await grant(owner, admin, {
      ability: "admin",
      depth: 1,
      expiresAt: T0 + 2 * HOUR,
    })
    const longer = await grant(admin, other, {
      proof: toAdmin.cid,
      expiresAt: T0 + 48 * HOUR,
    })

    const result = await verifyChain(longer, context(owner.did, [toAdmin, longer]))
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("validity")
  })

  // The link that is easy to forget: stapling your own token to someone else's
  // proof must not work.
  it("refuses a token stapled to a proof addressed to someone else", async () => {
    const owner = await principal()
    const admin = await principal()
    const mallory = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 2 })
    // Mallory issues to herself, citing a proof whose audience is the admin.
    const stapled = await grant(mallory, mallory, { proof: toAdmin.cid })

    const result = await verifyChain(stapled, context(owner.did, [toAdmin, stapled]))
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("not the audience of its proof")
  })
})

describe("validity and ability", () => {
  it("accepts a stronger ability than requested", async () => {
    const owner = await principal()
    const admin = await principal()
    const root = await grant(owner, admin, { ability: "admin" })
    const ctx = context(owner.did, [root])

    for (const ability of ["read", "write", "admin"] as const) {
      expect(
        (await authorize({ principal: admin.did, resource: RESOURCE, ability }, ctx)).authorized,
      ).toBe(true)
    }
  })

  it("refuses a weaker ability than requested", async () => {
    const owner = await principal()
    const reader = await principal()
    const root = await grant(owner, reader, { ability: "read" })

    const result = await authorize(
      { principal: reader.did, resource: RESOURCE, ability: "write" },
      context(owner.did, [root]),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("no-capability")
  })

  it("respects the validity window", async () => {
    const owner = await principal()
    const writer = await principal()
    const root = await grant(owner, writer, { notBefore: T0 + HOUR, expiresAt: T0 + 2 * HOUR })
    const query = { principal: writer.did, resource: RESOURCE, ability: "write" as const }

    expect((await authorize(query, context(owner.did, [root], T0))).reason).toBe("not-yet-valid")
    expect((await authorize(query, context(owner.did, [root], T0 + 90 * 60 * 1000))).authorized).toBe(
      true,
    )
    expect((await authorize(query, context(owner.did, [root], T0 + 3 * HOUR))).reason).toBe(
      "expired",
    )
  })

  it("covers a sub-resource but not a sibling", async () => {
    const owner = await principal()
    const writer = await principal()
    const root = await grant(owner, writer, { resource: "notebook:1" })
    const ctx = context(owner.did, [root])

    expect(
      (await authorize({ principal: writer.did, resource: "notebook:1/note:a", ability: "write" }, ctx))
        .authorized,
    ).toBe(true)
    // A prefix must not widen scope across the separator.
    expect(
      (await authorize({ principal: writer.did, resource: "notebook:10", ability: "write" }, ctx))
        .authorized,
    ).toBe(false)
  })

  // A principal may hold several grants; a bad one must not mask a good one.
  it("tries every candidate before denying", async () => {
    const owner = await principal()
    const writer = await principal()
    const expired = await grant(owner, writer, { expiresAt: T0 + HOUR })
    const good = await grant(owner, writer, { expiresAt: T0 + 48 * HOUR })

    const result = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      context(owner.did, [expired, good], T0 + 2 * HOUR),
    )
    expect(result.authorized).toBe(true)
  })
})

describe("hostile chains", () => {
  /**
   * Cycles are structurally impossible while attenuation holds: depth must
   * strictly decrease at every link, so returning to the same capability would
   * require its depth to be less than itself. The guard is defence in depth
   * against a corrupt proof map, and attenuation is what actually catches this.
   */
  it("refuses a proof map that resolves a parent back to its child", async () => {
    const owner = await principal()
    const admin = await principal()
    const other = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 3 })
    const toOther = await grant(admin, other, {
      ability: "admin",
      depth: 1,
      proof: toAdmin.cid,
    })

    const proofs = new Map([
      [toOther.cid, toOther],
      // The parent lookup resolves back to the child.
      [toAdmin.cid, toOther],
    ])
    const result = await verifyChain(toOther, { proofs, owner: owner.did, now: T0 })
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("attenuation")
    // It never gets far enough to loop.
    expect(result.detail).toContain("not the audience of its proof")
  })

  it("cannot construct a chain that returns to an earlier depth", async () => {
    const owner = await principal()
    const self = await principal()
    // Even a self-issued capability cannot be its own proof: depth must fall.
    const selfIssued = await grant(owner, owner, { ability: "admin", depth: 2 })
    const proofs = new Map([[selfIssued.cid, selfIssued]])
    const looping: Capability = await grant(owner, self, {
      ability: "admin",
      depth: 2,
      proof: selfIssued.cid,
    })
    proofs.set(looping.cid, looping)

    const result = await verifyChain(looping, { proofs, owner: owner.did, now: T0 })
    expect(result.authorized).toBe(false)
    expect(result.detail).toContain("depth")
  })

  // The token is canonical; a payload that disagrees with it must not be
  // trusted, or the chain walk would read an escalation the signature never
  // covered.
  it("refuses a capability whose payload disagrees with its signed token", async () => {
    const owner = await principal()
    const reader = await principal()
    const root = await grant(owner, reader, { ability: "read" })
    const escalated: Capability = {
      ...root,
      payload: { ...root.payload, can: "admin" },
    }

    expect(await verifyCapabilitySignature(escalated)).toBe(false)
    const result = await verifyChain(escalated, context(owner.did, [escalated]))
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("bad-signature")
  })

  it("refuses a chain longer than the bound", async () => {
    const owner = await principal()
    let issuer = owner
    const chain: Capability[] = []
    let proof: string | null = null

    // Longer than MAX_CHAIN_DEPTH, each link legitimately attenuating.
    for (let i = MAX_CHAIN_DEPTH + 4; i > 0; i -= 1) {
      const next = await principal()
      const capability: Capability = await grant(issuer, next, {
        ability: "admin",
        depth: i,
        proof,
      })
      chain.push(capability)
      proof = capability.cid
      issuer = next
    }

    const result = await verifyChain(chain[chain.length - 1], context(owner.did, chain))
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("chain-too-long")
  })

  it("refuses a tampered token", async () => {
    const owner = await principal()
    const writer = await principal()
    const root = await grant(owner, writer)
    const parts = root.token.split(".")
    const tampered: Capability = { ...root, token: `${parts[0]}.${parts[1]}.AAAA` }

    const result = await verifyChain(tampered, context(owner.did, [tampered]))
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("bad-signature")
  })

  it("denies a principal holding nothing", async () => {
    const owner = await principal()
    const stranger = await principal()
    const result = await authorize(
      { principal: stranger.did, resource: RESOURCE, ability: "read" },
      context(owner.did, []),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("no-capability")
  })
})

describe("revocation", () => {
  it("denies a revoked capability", async () => {
    const owner = await principal()
    const writer = await principal()
    const root = await grant(owner, writer)

    const store = new CapabilityStore(owner.did)
    await store.add(root)
    expect(
      (await authorize(
        { principal: writer.did, resource: RESOURCE, ability: "write" },
        store.context(T0),
      )).authorized,
    ).toBe(true)

    const revocation = await revokeCapability({
      signingKey: owner.key,
      issuer: owner.did,
      capabilityCid: root.cid,
      revokedAt: T0 + HOUR,
    })
    expect(await store.revoke(revocation, T0)).toBe(true)

    const after = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      store.context(T0 + 2 * HOUR),
    )
    expect(after.authorized).toBe(false)
    expect(after.reason).toBe("revoked")
  })

  // Anyone can sign a revocation for any cid; entitlement is what matters.
  it("ignores a revocation from someone outside the chain", async () => {
    const owner = await principal()
    const writer = await principal()
    const stranger = await principal()
    const root = await grant(owner, writer)

    const store = new CapabilityStore(owner.did)
    await store.add(root)
    const forged = await revokeCapability({
      signingKey: stranger.key,
      issuer: stranger.did,
      capabilityCid: root.cid,
    })

    expect(await store.revoke(forged, T0)).toBe(false)
    expect(
      (await authorize(
        { principal: writer.did, resource: RESOURCE, ability: "write" },
        store.context(T0),
      )).authorized,
    ).toBe(true)
  })

  it("accepts a revocation from an intermediate issuer on the chain", async () => {
    const owner = await principal()
    const admin = await principal()
    const writer = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 2 })
    const toWriter = await grant(admin, writer, { proof: toAdmin.cid })

    const store = new CapabilityStore(owner.did)
    await store.add(toAdmin)
    await store.add(toWriter)

    const byAdmin = await revokeCapability({
      signingKey: admin.key,
      issuer: admin.did,
      capabilityCid: toWriter.cid,
    })
    expect(await store.revoke(byAdmin, T0)).toBe(true)
    expect(store.isRevoked(toWriter.cid)).toBe(true)
  })

  // Revoking a link near the root must invalidate everything resting on it.
  it("denies a leaf whose proof was revoked", async () => {
    const owner = await principal()
    const admin = await principal()
    const writer = await principal()
    const toAdmin = await grant(owner, admin, { ability: "admin", depth: 2 })
    const toWriter = await grant(admin, writer, { proof: toAdmin.cid })

    const store = new CapabilityStore(owner.did)
    await store.add(toAdmin)
    await store.add(toWriter)
    await store.revoke(
      await revokeCapability({
        signingKey: owner.key,
        issuer: owner.did,
        capabilityCid: toAdmin.cid,
      }),
      T0,
    )

    const result = await authorize(
      { principal: writer.did, resource: RESOURCE, ability: "write" },
      store.context(T0),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe("revoked")
  })
})

/** The owner's own linked devices act as the owner; a former one, only for what was kept. */
describe("deputies", () => {
  async function ownerRoot(owner: Principal) {
    return grant(owner, owner, { ability: "admin", depth: 4 })
  }

  it("lets a deputy grant from the owner's root", async () => {
    const owner = await principal()
    const phone = await principal()
    const member = await principal()
    const root = await ownerRoot(owner)
    const issued = await grant(phone, member, { proof: root.cid })
    const query = { principal: member.did, resource: RESOURCE, ability: "write" as const }

    expect((await authorize(query, context(owner.did, [root, issued]))).authorized).toBe(false)
    const deputized = { ...context(owner.did, [root, issued]), deputies: new Map([[phone.did, owner.did]]) }
    expect((await authorize(query, deputized)).authorized).toBe(true)
  })

  it("holds the owner's authority as a deputy", async () => {
    const owner = await principal()
    const phone = await principal()
    const root = await ownerRoot(owner)
    const query = { principal: phone.did, resource: RESOURCE, ability: "admin" as const }

    const deputized = { ...context(owner.did, [root]), deputies: new Map([[phone.did, owner.did]]) }
    expect((await authorize(query, deputized)).authorized).toBe(true)
  })

  it("keeps a former deputy's grant only if it was kept", async () => {
    const owner = await principal()
    const phone = await principal()
    const member = await principal()
    const root = await ownerRoot(owner)
    const issued = await grant(phone, member, { proof: root.cid })
    const query = { principal: member.did, resource: RESOURCE, ability: "write" as const }

    const kept = { ...context(owner.did, [root, issued]), kept: new Set([issued.cid]) }
    expect((await authorize(query, kept)).authorized).toBe(true)
  })

  /** Removing someone from the phone has to withdraw what the laptop granted them. */
  it("lets a deputy revoke what the owner granted, and nobody else", async () => {
    const owner = await principal()
    const phone = await principal()
    const stranger = await principal()
    const member = await principal()
    const root = await ownerRoot(owner)
    const issued = await grant(owner, member, { proof: root.cid })
    const revokeAs = (by: Principal) =>
      revokeCapability({ signingKey: by.key, issuer: by.did, capabilityCid: issued.cid, revokedAt: T0 })

    const store = new CapabilityStore(owner.did, { deputies: new Map([[phone.did, owner.did]]) })
    await store.add(root)
    await store.add(issued)
    expect(await store.revoke(await revokeAs(stranger), T0)).toBe(false)
    expect(await store.revoke(await revokeAs(phone), T0)).toBe(true)
  })
})
