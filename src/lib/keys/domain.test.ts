import { describe, expect, it } from "vitest"
import { toHex } from "@/lib/crypto"
import { foundDomain, newMember, NOTEBOOK, type Member } from "@/test/key-fixtures"
import { KeyDomainAdmin, readKeysFor, type ReadKeySource } from "./domain"
import type { SealedEpochKey } from "./keyring"

async function viewFor(
  member: Member,
  timeline: Parameters<typeof readKeysFor>[0],
  keyring: SealedEpochKey[],
): Promise<ReadKeySource & { anchorEpochs: number[] }> {
  return readKeysFor(timeline, keyring, member.sealingDid, member.sealingKey)
}

describe("founding a domain", () => {
  it("seals the genesis key to every founder", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice, bob])

    expect(admin.currentEpoch).toBe(1)
    expect(keyring).toHaveLength(2)
    expect((await viewFor(alice, admin.timeline, keyring)).readableEpochs()).toEqual([1])
    expect((await viewFor(bob, admin.timeline, keyring)).readableEpochs()).toEqual([1])
  })

  it("gives a non-member nothing", async () => {
    const alice = await newMember("alice")
    const stranger = await newMember("stranger")
    const { admin, keyring } = await foundDomain([alice])

    const view = await viewFor(stranger, admin.timeline, keyring)
    expect(view.readableEpochs()).toEqual([])
    expect(await view.keyFor(1)).toBeUndefined()
  })
})

describe("adding a member excludes history", () => {
  // The default the design calls for, enforced cryptographically rather than by
  // client policy: a joiner simply cannot derive backwards.
  it("lets a joiner read from their join epoch onward, never before", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice])

    expect(admin.currentEpoch).toBe(1)
    const joined = await admin.addMember(bob, { createdAt: 2_000 })
    keyring.push(...joined.sealed)

    const bobView = await viewFor(bob, admin.timeline, keyring)
    expect(bobView.readableEpochs()).toEqual([2])
    expect(await bobView.keyFor(1)).toBeUndefined()
    expect(await bobView.keyFor(2)).toBeDefined()
  })

  // The payoff of chaining joins: existing members derive the new key, so only
  // the joiner needs a sealed copy.
  it("seals only to the joiner, and existing members derive the rest", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice])

    const joined = await admin.addMember(bob, { createdAt: 2_000 })
    expect(joined.sealed).toHaveLength(1)
    expect(joined.sealed[0].recipient).toBe(bob.sealingDid)

    keyring.push(...joined.sealed)
    const aliceView = await viewFor(alice, admin.timeline, keyring)
    expect(aliceView.anchorEpochs).toEqual([1])
    expect(aliceView.readableEpochs()).toEqual([1, 2])
    expect(toHex((await aliceView.keyFor(2))!)).toBe(toHex(joined.key))
  })

  it("keeps the keyring near-constant across many joins", async () => {
    const alice = await newMember("alice")
    const { admin, keyring } = await foundDomain([alice])

    for (let i = 0; i < 12; i += 1) {
      const joiner = await newMember(`joiner-${i}`)
      keyring.push(...(await admin.addMember(joiner)).sealed)
    }

    const aliceView = await viewFor(alice, admin.timeline, keyring)
    // One anchor, thirteen readable epochs.
    expect(aliceView.anchorEpochs).toEqual([1])
    expect(aliceView.readableEpochs()).toHaveLength(13)
  })
})

describe("removing a member denies future reads", () => {
  it("rotates away from the removed member", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice, bob])

    const removed = await admin.removeMember([alice], { createdAt: 3_000 })
    keyring.push(...removed.sealed)

    const bobView = await viewFor(bob, admin.timeline, keyring)
    expect(await bobView.keyFor(2)).toBeUndefined()
    expect(bobView.readableEpochs()).toEqual([1])

    const aliceView = await viewFor(alice, admin.timeline, keyring)
    expect(aliceView.readableEpochs()).toEqual([1, 2])
  })

  // The property that makes removal mean anything: keeping old keys does not
  // help, because the chain cannot cross a rotation.
  it("does not let a removed member derive forward from what they kept", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice, bob])

    keyring.push(...(await admin.removeMember([alice])).sealed)
    // Two more epochs pass after the removal.
    const carol = await newMember("carol")
    keyring.push(...(await admin.addMember(carol)).sealed)
    keyring.push(...(await admin.rotate([alice, carol])).sealed)

    const bobView = await viewFor(bob, admin.timeline, keyring)
    expect(bobView.readableEpochs()).toEqual([1])
    for (const epoch of [2, 3, 4]) expect(await bobView.keyFor(epoch)).toBeUndefined()
  })

  it("flat-reseals to everyone who remains", async () => {
    const members = await Promise.all(["a", "b", "c", "d"].map(newMember))
    const { admin } = await foundDomain(members)
    const remaining = members.slice(1)

    const removed = await admin.removeMember(remaining)
    expect(removed.sealed).toHaveLength(3)
    expect(removed.sealed.map((s) => s.recipient).sort()).toEqual(
      remaining.map((m) => m.sealingDid).sort(),
    )
  })

  it("accumulates one anchor per segment, not one per epoch", async () => {
    const alice = await newMember("alice")
    const { admin, keyring } = await foundDomain([alice])

    for (let i = 0; i < 3; i += 1) {
      keyring.push(...(await admin.addMember(await newMember(`j${i}`))).sealed)
      keyring.push(...(await admin.removeMember([alice])).sealed)
    }

    const aliceView = await viewFor(alice, admin.timeline, keyring)
    expect(admin.currentEpoch).toBe(7)
    // Genesis plus one per rotation - joins cost her nothing.
    expect(aliceView.anchorEpochs).toEqual([1, 3, 5, 7])
    expect(aliceView.readableEpochs()).toHaveLength(7)
  })
})

describe("manual rotation", () => {
  it("rotates without a membership change", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice, bob])

    const rotated = await admin.rotate([alice, bob])
    keyring.push(...rotated.sealed)

    expect(rotated.record.reason).toBe("manual-rotation")
    expect(rotated.record.kind).toBe("rotation")
    expect((await viewFor(alice, admin.timeline, keyring)).readableEpochs()).toEqual([1, 2])
    expect((await viewFor(bob, admin.timeline, keyring)).readableEpochs()).toEqual([1, 2])
  })
})

describe("the writer's view", () => {
  it("resolves its own current key across a chain", async () => {
    const alice = await newMember("alice")
    const { admin } = await foundDomain([alice])
    const joined = await admin.addMember(await newMember("bob"))
    expect(toHex(await admin.currentKey())).toBe(toHex(joined.key))
  })

  it("restores from a timeline plus held keys", async () => {
    const alice = await newMember("alice")
    const { admin } = await foundDomain([alice])
    await admin.addMember(await newMember("bob"))

    const restored = KeyDomainAdmin.restore(
      admin.timeline,
      new Map([[1, (await admin.keyFor(1))!]]),
    )
    expect(restored.currentEpoch).toBe(2)
    expect(toHex(await restored.currentKey())).toBe(toHex(await admin.currentKey()))
  })

  it("refuses to hand out a current key it cannot reach", async () => {
    const alice = await newMember("alice")
    const { admin } = await foundDomain([alice])
    await admin.removeMember([])

    const stale = KeyDomainAdmin.restore(admin.timeline, new Map([[1, (await admin.keyFor(1))!]]))
    await expect(stale.currentKey()).rejects.toThrow(/no key held for the current epoch/)
  })
})

describe("the keyring is safe in the open", () => {
  it("contains no usable key material for a non-recipient", async () => {
    const alice = await newMember("alice")
    const bob = await newMember("bob")
    const { admin, keyring } = await foundDomain([alice])
    keyring.push(...(await admin.addMember(bob)).sealed)

    // Everything is sealed; the serialised keyring reveals only DIDs and epochs.
    const serialised = JSON.stringify(keyring)
    const aliceKey = await admin.keyFor(1)
    expect(serialised).not.toContain(toHex(aliceKey!))
    expect(keyring.every((copy) => copy.domain === NOTEBOOK)).toBe(true)
  })
})
