/**
 * M8's exit criterion:
 *
 *   a removed member cannot write accepted updates
 *   a removed member cannot decrypt post-removal content
 *   staleness of the revocation set is detectable
 *
 * Driven through the real sync engine, the real keyring and the real capability
 * store, so the two halves of removal are exercised as they compose rather than
 * separately.
 */

import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateSealingKey, type SealingKey, type SigningKey } from "@/lib/crypto"
import { bindDocumentClientId, didFromSealingKey } from "@/lib/identity"
import { putAdmission, putDeviceRecord } from "@/lib/directory"
import { admitDevice, newAdmin, type Admin } from "@/test/identity-fixtures"
import {
  DirectoryAuthorResolver,
  MemoryRelay,
  SyncEngine,
  type RelayTransport,
} from "@/lib/sync"
import {
  FlatKeyring,
  KeyDomainAdmin,
  KeyringEpochProvider,
  readKeysFor,
  refreshKeysFor,
  sealEpochKey,
  type SealedEpochKey,
} from "@/lib/keys"
import {
  CapabilityStore,
  CapabilityWritePolicy,
  issueCapability,
  type Ability,
  type Capability,
} from "@/lib/authz"
import { addMember, changeMemberLevel, removeMember } from "./lifecycle"
import { verifyTimeline } from "./epoch-timeline"

const RESOURCE = "notebook:1"
const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

interface Party {
  name: string
  did: string
  signingKey: SigningKey
  sealingDid: string
  sealingKey: SealingKey
  source: FlatKeyring
  doc: Y.Doc
  text: Y.Text
  engine: SyncEngine
  transport: RelayTransport
  capability?: Capability
}

interface World {
  admin: Admin
  owner: { did: string; signingKey: SigningKey; sealingDid: string; sealingKey: SealingKey }
  directory: Y.Doc
  relay: MemoryRelay
  keys: KeyDomainAdmin
  keyring: SealedEpochKey[]
  store: CapabilityStore
  signedEpochs: Awaited<ReturnType<typeof addMember>>["epochRecord"][]
}

async function newSealing() {
  const sealingKey = await generateSealingKey()
  return { sealingKey, sealingDid: didFromSealingKey(sealingKey.publicKey) }
}

async function newWorld(): Promise<World> {
  const admin = await newAdmin()
  const ownerDevice = await admitDevice(admin, { member: "member:owner", label: "Owner" })
  const ownerSealing = await newSealing()
  const directory = new Y.Doc()
  putDeviceRecord(directory, ownerDevice.record)
  putAdmission(directory, ownerDevice.admission)

  const { admin: keys, sealed } = await KeyDomainAdmin.create(
    RESOURCE,
    [{ sealingDid: ownerSealing.sealingDid }],
    { createdAt: T0 },
  )
  const store = new CapabilityStore(ownerDevice.record.did)

  // The owner roots their own admin authority.
  await store.add(
    await issueCapability({
      signingKey: ownerDevice.key,
      issuer: ownerDevice.record.did,
      audience: ownerDevice.record.did,
      resource: RESOURCE,
      ability: "admin",
      depth: 4,
      notBefore: T0,
      expiresAt: T0 + 365 * DAY,
    }),
  )

  return {
    admin,
    owner: {
      did: ownerDevice.record.did,
      signingKey: ownerDevice.key,
      sealingDid: ownerSealing.sealingDid,
      sealingKey: ownerSealing.sealingKey,
    },
    directory,
    relay: new MemoryRelay(),
    keys,
    keyring: [...sealed],
    store,
    signedEpochs: [],
  }
}

/** Attach a device already holding the genesis key and a capability. */
async function attach(world: World, name: string, ability: Ability): Promise<Party> {
  const device = await admitDevice(world.admin, { member: `member:${name}`, label: name })
  putDeviceRecord(world.directory, device.record)
  putAdmission(world.directory, device.admission)

  const sealing = await newSealing()
  const capability = await issueCapability({
    signingKey: world.owner.signingKey,
    issuer: world.owner.did,
    audience: device.record.did,
    resource: RESOURCE,
    ability,
    notBefore: T0,
    expiresAt: T0 + 30 * DAY,
  })
  await world.store.add(capability)

  world.keyring.push(
    await sealEpochKey(RESOURCE, 1, sealing.sealingDid, (await world.keys.keyFor(1))!),
  )

  const doc = new Y.Doc()
  const clientId = await bindDocumentClientId(doc, device.key.publicKey)
  // A copy, not the domain's live array: each client holds its own
  // materialised view, and a stale one is exactly what the seal gate is about.
  const source = await readKeysFor(
    [...world.keys.timeline],
    [...world.keyring],
    sealing.sealingDid,
    sealing.sealingKey,
  )
  const transport = world.relay.attach(name)

  return {
    name,
    did: device.record.did,
    signingKey: device.key,
    sealingDid: sealing.sealingDid,
    sealingKey: sealing.sealingKey,
    source,
    doc,
    text: doc.getText("content"),
    engine: new SyncEngine({
      doc,
      resourceId: RESOURCE,
      author: device.record.did,
      signingKey: device.key,
      clientId,
      transport,
      authors: new DirectoryAuthorResolver({
        directory: world.directory,
        trustedAdminDids: [world.admin.did],
      }),
      policy: new CapabilityWritePolicy(() => world.store.context(T0)),
      keys: new KeyringEpochProvider(source),
    }),
    transport,
    capability,
  }
}

async function settle(...parties: Party[]): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    for (const party of parties) await party.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const quiet = await Promise.all(parties.map((p) => p.engine.isQuiescent()))
    if (quiet.every(Boolean)) return
  }
}

async function refreshAll(world: World, ...parties: Party[]): Promise<void> {
  for (const party of parties) {
    await refreshKeysFor(
      party.source,
      [...world.keys.timeline],
      [...world.keyring],
      party.sealingDid,
      party.sealingKey,
    )
  }
}

describe("removal: revoke plus rotate plus reseal", () => {
  // The exit criterion, both halves at once.
  it("denies a removed member both writes and post-removal reads", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const mallory = await attach(world, "mallory", "write")

    // Both are members and converge normally.
    alice.engine.transact(() => alice.text.insert(0, "before-removal "))
    await settle(alice, mallory)
    expect(mallory.text.toJSON()).toBe("before-removal ")

    const removal = await removeMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      memberDid: mallory.did,
      held: [mallory.capability!],
      remaining: [
        { sealingDid: world.owner.sealingDid },
        { sealingDid: alice.sealingDid },
      ],
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      now: T0 + DAY,
    })
    // Assert the count first: an empty list would make the loop below vacuous.
    expect(removal.revocations).toHaveLength(1)
    for (const revocation of removal.revocations) {
      expect(await world.store.revoke(revocation, T0)).toBe(true)
    }
    expect(world.store.isRevoked(mallory.capability!.cid)).toBe(true)
    world.keyring.push(...removal.sealed)
    // Only Alice refreshes. Mallory's client keeps its old view, which is the
    // hostile case: she can still seal under epoch 1 and try to write.
    await refreshAll(world, alice)

    // 1. Cannot write accepted updates. The envelope is authored and signed -
    //    and refused on authorization, because her capability was revoked.
    mallory.engine.transact(() => mallory.text.insert(mallory.text.length, "MALLORY"))
    await settle(alice, mallory)
    expect(mallory.engine.stats.published).toBe(1)
    expect(alice.engine.stats.applied).toBe(0)
    expect(alice.text.toJSON()).toBe("before-removal ")
    expect(alice.engine.stats.rejected.unauthorized).toBeGreaterThan(0)

    // 2. Cannot decrypt post-removal content.
    alice.engine.transact(() => alice.text.insert(alice.text.length, "after-removal"))
    await settle(alice, mallory)
    expect(alice.text.toJSON()).toBe("before-removal after-removal")

    // Her own rejected edit still shows locally - nothing can stop a
    // local-first client editing its own replica. What she does not get is
    // anything written after the rotation.
    expect(mallory.text.toJSON()).toBe("before-removal MALLORY")
    expect(mallory.text.toJSON()).not.toContain("after-removal")
    expect(mallory.engine.stats.rejected["unknown-epoch"]).toBeGreaterThan(0)

    // The removed member keeps what they already had, and nothing more.
    await refreshAll(world, mallory)
    expect(mallory.source.readableEpochs()).toEqual([1])
    expect(alice.source.readableEpochs()).toEqual([1, 2])
  })

  /**
   * The stronger outcome, once the removed member's own client catches up: it
   * cannot author at all, because there is no current epoch key to seal under.
   * Refusing to write is better than writing envelopes nobody can read.
   */
  it("leaves a removed member unable to author once its own view refreshes", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const mallory = await attach(world, "mallory", "write")

    const removal = await removeMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      memberDid: mallory.did,
      held: [mallory.capability!],
      remaining: [{ sealingDid: world.owner.sealingDid }, { sealingDid: alice.sealingDid }],
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      now: T0 + DAY,
    })
    world.keyring.push(...removal.sealed)
    await refreshAll(world, alice, mallory)

    const before = mallory.engine.stats.published
    mallory.engine.transact(() => mallory.text.insert(0, "should not be sealable"))
    await settle(alice, mallory)

    expect(mallory.engine.stats.published).toBe(before)
    expect(alice.text.toJSON()).toBe("")
  })

  // Rotation is the backstop: it works even where revocation has not arrived.
  it("denies reads even to a peer that never saw the revocation", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const mallory = await attach(world, "mallory", "write")

    const removal = await removeMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      memberDid: mallory.did,
      held: [mallory.capability!],
      remaining: [{ sealingDid: world.owner.sealingDid }, { sealingDid: alice.sealingDid }],
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      now: T0 + DAY,
    })
    // Deliberately do NOT apply the revocations - model a relay withholding them.
    world.keyring.push(...removal.sealed)
    await refreshAll(world, alice, mallory)

    alice.engine.transact(() => alice.text.insert(0, "post-rotation"))
    await settle(alice, mallory)

    // Mallory's write capability still looks live to everyone...
    expect(world.store.isRevoked(mallory.capability!.cid)).toBe(false)
    // ...and she still cannot read, because the key moved.
    expect(mallory.text.toJSON()).toBe("")
    expect(await mallory.source.keyFor(2)).toBeUndefined()
  })

  it("signs the epoch cut it produces", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const removal = await removeMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      memberDid: alice.did,
      held: [alice.capability!],
      remaining: [{ sealingDid: world.owner.sealingDid }],
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      now: T0 + DAY,
    })

    expect(removal.record.kind).toBe("rotation")
    expect(removal.record.reason).toBe("member-removed")
    expect(removal.epochRecord.asserter).toBe(world.owner.did)
  })

  // The seal gate from M5's finding, now enforced.
  it("refuses to remove from a stale keyring view", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    await world.keys.rotate([{ sealingDid: world.owner.sealingDid }])

    await expect(
      removeMember({
        admin: { signingKey: world.owner.signingKey, did: world.owner.did },
        domain: world.keys,
        resource: RESOURCE,
        memberDid: alice.did,
        held: [alice.capability!],
        remaining: [{ sealingDid: world.owner.sealingDid }],
        // A view still at the pre-rotation epoch.
        keyring: { domain: RESOURCE, currentEpoch: 1 },
        now: T0 + DAY,
      }),
    ).rejects.toThrow(/Refresh first/)
  })
})

describe("adding a member", () => {
  it("cuts, seals, snapshots and grants atomically", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    alice.engine.transact(() => alice.text.insert(0, "existing content"))
    await settle(alice)

    const joiner = await newSealing()
    const joinerDevice = await admitDevice(world.admin, {
      member: "member:joiner",
      label: "Joiner",
    })

    const result = await addMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      joinerDid: joinerDevice.record.did,
      joinerSealingDid: joiner.sealingDid,
      ability: "write",
      doc: alice.doc,
      covers: alice.engine.snapshotCoverage(),
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      expiresAt: T0 + 30 * DAY,
      now: T0 + DAY,
    })

    // All four artefacts, from one call.
    expect(result.grant.record.kind).toBe("chain")
    expect(result.grant.sealed).toHaveLength(1)
    expect(result.snapshot).not.toBeNull()
    expect(result.snapshot?.epoch).toBe(result.grant.record.epoch)
    expect(result.capability.payload.aud).toBe(joinerDevice.record.did)
    expect(result.epochRecord.asserter).toBe(world.owner.did)
  })

  it("refuses to add from a stale keyring view", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    await world.keys.rotate([{ sealingDid: world.owner.sealingDid }])
    const joiner = await newSealing()

    await expect(
      addMember({
        admin: { signingKey: world.owner.signingKey, did: world.owner.did },
        domain: world.keys,
        resource: RESOURCE,
        joinerDid: alice.did,
        joinerSealingDid: joiner.sealingDid,
        ability: "read",
        doc: alice.doc,
        covers: {},
        keyring: { domain: RESOURCE, currentEpoch: 1 },
        expiresAt: T0 + DAY,
      }),
    ).rejects.toThrow(/Refresh first/)
  })
})

describe("changing a member's level", () => {
  it("revokes the old grant and issues the narrower one", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")

    const change = await changeMemberLevel({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      resource: RESOURCE,
      memberDid: alice.did,
      held: [alice.capability!],
      ability: "read",
      expiresAt: T0 + 30 * DAY,
      now: T0 + DAY,
    })
    for (const revocation of change.revocations) {
      await world.store.revoke(revocation, T0)
    }
    await world.store.add(change.capability)

    expect(change.capability.payload.can).toBe("read")
    expect(world.store.isRevoked(alice.capability!.cid)).toBe(true)

    // The downgrade bites: her writes stop being accepted.
    const bob = await attach(world, "bob", "write")
    alice.engine.transact(() => alice.text.insert(0, "after downgrade"))
    await settle(alice, bob)
    expect(bob.text.toJSON()).toBe("")
    expect(bob.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
  })

  it("does not touch other members' grants", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const bob = await attach(world, "bob", "write")

    const change = await changeMemberLevel({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      resource: RESOURCE,
      memberDid: alice.did,
      // Bob's capability is offered too; only Alice's should be revoked.
      held: [alice.capability!, bob.capability!],
      ability: "read",
      expiresAt: T0 + 30 * DAY,
      now: T0,
    })

    expect(change.revocations).toHaveLength(1)
    expect(change.revocations[0].cid).toBe(alice.capability!.cid)
  })
})

describe("the signed epoch timeline", () => {
  it("verifies a timeline asserted by an admin", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const { signEpochRecord } = await import("./epoch-timeline")

    const genesis = await signEpochRecord(
      world.keys.timeline[0],
      world.owner.signingKey,
      world.owner.did,
    )
    const removal = await removeMember({
      admin: { signingKey: world.owner.signingKey, did: world.owner.did },
      domain: world.keys,
      resource: RESOURCE,
      memberDid: alice.did,
      held: [alice.capability!],
      remaining: [{ sealingDid: world.owner.sealingDid }],
      keyring: { domain: RESOURCE, currentEpoch: world.keys.currentEpoch },
      now: T0 + DAY,
    })

    const verified = await verifyTimeline(
      [genesis, removal.epochRecord],
      world.store.context(T0),
    )
    expect(verified.ok).toBe(true)
    expect(verified.timeline).toHaveLength(2)
    expect(verified.timeline?.[1].kind).toBe("rotation")
  })

  // The point of signing: a relay cannot claim a rotation was a chain step, or
  // the reverse, to confuse a member's derivation.
  it("passes over a record whose kind was altered in transit, and refuses a hole", async () => {
    const world = await newWorld()
    const { signEpochRecord } = await import("./epoch-timeline")
    const genesis = await signEpochRecord(
      world.keys.timeline[0],
      world.owner.signingKey,
      world.owner.did,
    )
    const cut = await world.keys.addMember({ sealingDid: world.owner.sealingDid })
    const signed = await signEpochRecord(cut.record, world.owner.signingKey, world.owner.did)

    const forged = { ...signed, record: { ...signed.record, kind: "rotation" as const } }

    // Beside the real one, the altered copy is passed over.
    const beside = await verifyTimeline([genesis, forged, signed], world.store.context(T0))
    expect(beside.ok).toBe(true)
    expect(beside.timeline?.map((record) => record.kind)).toEqual([genesis.record.kind, signed.record.kind])
    // Alone past the last real epoch, it is someone's junk and does not stop the rest.
    const past = await verifyTimeline([genesis, forged], world.store.context(T0))
    expect(past.ok).toBe(true)
    expect(past.timeline).toHaveLength(1)
    // Before a real epoch it is a hole, and refused.
    const later = await world.keys.addMember({ sealingDid: world.owner.sealingDid })
    const after = await signEpochRecord(later.record, world.owner.signingKey, world.owner.did)
    const hole = await verifyTimeline([genesis, forged, after], world.store.context(T0))
    expect(hole.ok).toBe(false)
    expect(hole.reason).toBe("unsigned-record")
    expect(hole.failedAt).toBe(2)
  })

  it("refuses a record asserted by a non-admin", async () => {
    const world = await newWorld()
    const alice = await attach(world, "alice", "write")
    const { signEpochRecord } = await import("./epoch-timeline")

    const signed = await signEpochRecord(world.keys.timeline[0], alice.signingKey, alice.did)
    const verified = await verifyTimeline([signed], world.store.context(T0))

    expect(verified.ok).toBe(false)
    expect(verified.reason).toBe("unauthorized-asserter")
  })

  it("refuses a timeline with a hole rather than truncating it", async () => {
    const world = await newWorld()
    const { signEpochRecord } = await import("./epoch-timeline")
    const genesis = await signEpochRecord(
      world.keys.timeline[0],
      world.owner.signingKey,
      world.owner.did,
    )
    await world.keys.addMember({ sealingDid: world.owner.sealingDid })
    const third = await world.keys.addMember({ sealingDid: world.owner.sealingDid })
    const signedThird = await signEpochRecord(
      third.record,
      world.owner.signingKey,
      world.owner.did,
    )

    // Epoch 2 is missing.
    const verified = await verifyTimeline([genesis, signedThird], world.store.context(T0))
    expect(verified.ok).toBe(false)
    expect(verified.reason).toBe("malformed")
  })
})
