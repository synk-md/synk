/**
 * The join grant: produced by the admitting admin atomically with the epoch
 * cut, deposited in the relay archive, collected by the joiner with no member
 * online.
 */

import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateSealingKey, type SealingKey, type SigningKey } from "@/lib/crypto"
import { bindDocumentClientId, didFromSealingKey } from "@/lib/identity"
import { putAdmission, putDeviceRecord } from "@/lib/directory"
import { admitDevice, newAdmin, type Admin } from "@/test/identity-fixtures"
import {
  DirectoryAuthorResolver,
  DirectoryMembershipPolicy,
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
  type SealedEpochKey,
} from "@/lib/keys"
import {
  admissionStaleness,
  admitMemberWithSnapshot,
  collectJoinSnapshot,
  depositJoinGrant,
} from "./join-grant"
import { verifySnapshot, type Snapshot } from "./snapshot"

const RESOURCE = "notebook:1"

interface Party {
  name: string
  did: string
  clientId: number
  sealingDid: string
  sealingKey: SealingKey
  signingKey: SigningKey
  source: FlatKeyring
  doc: Y.Doc
  text: Y.Text
  engine: SyncEngine
  transport: RelayTransport
}

interface World {
  admin: Admin
  directory: Y.Doc
  relay: MemoryRelay
  keys: KeyDomainAdmin
  keyring: SealedEpochKey[]
}

async function newSealing() {
  const sealingKey = await generateSealingKey()
  return { sealingKey, sealingDid: didFromSealingKey(sealingKey.publicKey) }
}

async function attach(
  world: World,
  name: string,
  sealing: Awaited<ReturnType<typeof newSealing>>,
): Promise<Party> {
  const device = await admitDevice(world.admin, { member: `member:${name}`, label: name })
  putDeviceRecord(world.directory, device.record)
  putAdmission(world.directory, device.admission)

  const doc = new Y.Doc()
  const clientId = await bindDocumentClientId(doc, device.key.publicKey)
  const authority = { directory: world.directory, trustedAdminDids: [world.admin.did] }
  const source = await readKeysFor(
    world.keys.timeline,
    world.keyring,
    sealing.sealingDid,
    sealing.sealingKey,
  )
  const transport = world.relay.attach(name)

  return {
    name,
    did: device.record.did,
    clientId,
    sealingDid: sealing.sealingDid,
    sealingKey: sealing.sealingKey,
    signingKey: device.key,
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
      authors: new DirectoryAuthorResolver(authority),
      policy: new DirectoryMembershipPolicy(authority),
      keys: new KeyringEpochProvider(source),
    }),
    transport,
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

async function newWorld(founderCount = 1) {
  const sealings = await Promise.all(
    Array.from({ length: founderCount }, () => newSealing()),
  )
  const admin = await newAdmin()
  const { admin: keys, sealed } = await KeyDomainAdmin.create(
    RESOURCE,
    sealings.map((s) => ({ sealingDid: s.sealingDid })),
  )
  const world: World = {
    admin,
    directory: new Y.Doc(),
    relay: new MemoryRelay(),
    keys,
    keyring: [...sealed],
  }
  return { world, sealings }
}

const verifier = (snapshot: Snapshot, author: { publicKey: Uint8Array }) =>
  verifySnapshot(snapshot, author.publicKey)

describe("admission and snapshot are atomic", () => {
  it("produces both together from the admitting admin's replica", async () => {
    const { world, sealings } = await newWorld()
    const alice = await attach(world, "alice", sealings[0])
    alice.engine.transact(() => alice.text.insert(0, "existing content"))
    await settle(alice)

    const joiner = await newSealing()
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: joiner.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
    })

    expect(grant.record.epoch).toBe(2)
    expect(grant.sealed).toHaveLength(1)
    expect(grant.snapshot).not.toBeNull()
    // Sealed under the NEW epoch and attributed to the admitting admin.
    expect(grant.snapshot?.epoch).toBe(2)
    expect(grant.snapshot?.author).toBe(alice.did)
    expect(grant.snapshot?.kind).toBe("join")
  })

  // The invariant: no path yields a grant the joiner cannot use.
  it("does not advance the epoch when the snapshot cannot be produced", async () => {
    const { world, sealings } = await newWorld()
    const alice = await attach(world, "alice", sealings[0])
    alice.engine.transact(() => alice.text.insert(0, "existing"))
    await settle(alice)

    const before = world.keys.currentEpoch
    const failing: SigningKey = {
      ...alice.signingKey,
      sign: () => Promise.reject(new Error("signing device unavailable")),
    }

    await expect(
      admitMemberWithSnapshot({
        domain: world.keys,
        joiner: { sealingDid: (await newSealing()).sealingDid },
        doc: alice.doc,
        signingKey: failing,
        author: alice.did,
        resourceId: RESOURCE,
        covers: alice.engine.snapshotCoverage(),
      }),
    ).rejects.toThrow(/signing device unavailable/)

    expect(world.keys.currentEpoch).toBe(before)
  })

  it("omits the snapshot for an empty notebook, where there are no gaps", async () => {
    const { world, sealings } = await newWorld()
    const alice = await attach(world, "alice", sealings[0])

    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: (await newSealing()).sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: {},
    })
    expect(grant.snapshot).toBeNull()
    expect(grant.record.epoch).toBe(2)
  })
})

describe("the joiner needs nobody online", () => {
  it("collects the grant and snapshot from the relay after the admin leaves", async () => {
    const { world, sealings } = await newWorld(2)
    const alice = await attach(world, "alice", sealings[0])
    const bob = await attach(world, "bob", sealings[1])

    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "a"))
    await settle(alice, bob)
    bob.engine.transact(() => bob.doc.getMap("pre").set("bob", "b"))
    await settle(alice, bob)

    // Alice admits a joiner and deposits everything, then goes away.
    const joinerSealing = await newSealing()
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: joinerSealing.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
    })
    world.keyring.push(...grant.sealed)
    await depositJoinGrant(alice.transport, grant)

    alice.engine.close()
    alice.transport.close()
    bob.engine.close()
    bob.transport.close()

    // Nobody is online. The joiner arrives and picks both up from the relay.
    const dave = await attach(world, "dave", joinerSealing)
    const collected = await collectJoinSnapshot({
      transport: dave.transport,
      resourceId: RESOURCE,
      readableEpochs: dave.source.readableEpochs(),
    })
    expect(collected?.id).toBe(grant.snapshot?.id)

    expect(await dave.engine.applySnapshot(collected!, verifier)).toBe(true)
    expect(dave.doc.getMap("pre").get("alice")).toBe("a")
    expect(dave.doc.getMap("pre").get("bob")).toBe("b")
  })

  it("ignores archived snapshots sealed under epochs it cannot open", async () => {
    const { world, sealings } = await newWorld()
    const alice = await attach(world, "alice", sealings[0])
    alice.engine.transact(() => alice.text.insert(0, "first era"))
    await settle(alice)

    // A snapshot under epoch 1, which a later joiner will never hold.
    const early = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: (await newSealing()).sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
      createdAt: 1_000,
    })
    world.keyring.push(...early.sealed)
    await depositJoinGrant(alice.transport, early)

    await refreshKeysFor(
      alice.source,
      world.keys.timeline,
      world.keyring,
      alice.sealingDid,
      alice.sealingKey,
    )
    const daveSealing = await newSealing()
    const late = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: daveSealing.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
      parent: early.snapshot?.id ?? null,
      createdAt: 2_000,
    })
    world.keyring.push(...late.sealed)
    await depositJoinGrant(alice.transport, late)

    const dave = await attach(world, "dave", daveSealing)
    const collected = await collectJoinSnapshot({
      transport: dave.transport,
      resourceId: RESOURCE,
      readableEpochs: dave.source.readableEpochs(),
    })

    expect(dave.source.readableEpochs()).toEqual([3])
    expect(collected?.id).toBe(late.snapshot?.id)
    expect(collected?.epoch).toBe(3)
    // The chain links back through the earlier grant.
    expect(collected?.parent).toBe(early.snapshot?.id)
  })
})

describe("staleness: what replay heals and what it does not", () => {
  /**
   * The healing case. Anything written after the cut is under an epoch the
   * joiner holds, so ordinary replay closes the gap.
   */
  it("heals a gap in content written after the join cut", async () => {
    const { world, sealings } = await newWorld(2)
    const alice = await attach(world, "alice", sealings[0])
    const bob = await attach(world, "bob", sealings[1])

    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "a"))
    await settle(alice, bob)

    const joinerSealing = await newSealing()
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: joinerSealing.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
    })
    world.keyring.push(...grant.sealed)
    await depositJoinGrant(alice.transport, grant)
    for (const party of [alice, bob]) {
      await refreshKeysFor(
        party.source,
        world.keys.timeline,
        world.keyring,
        party.sealingDid,
        party.sealingKey,
      )
    }

    // Written after the cut, while the joiner is not yet present.
    bob.engine.transact(() => bob.doc.getMap("post").set("bob", "after-the-cut"))
    await settle(alice, bob)

    const dave = await attach(world, "dave", joinerSealing)
    const collected = await collectJoinSnapshot({
      transport: dave.transport,
      resourceId: RESOURCE,
      readableEpochs: dave.source.readableEpochs(),
    })
    await dave.engine.applySnapshot(collected!, verifier)
    await dave.engine.sync()
    await settle(dave)

    expect(dave.doc.getMap("post").get("bob")).toBe("after-the-cut")
  })

  /**
   * The limit, asserted rather than assumed. An envelope written under a
   * *pre-join* epoch that the admin had not seen is in neither the snapshot nor
   * the joiner's reach - they cannot decrypt it, so replaying it achieves
   * nothing. This is why the guard below exists.
   */
  it("cannot heal pre-join-epoch content the admin never saw", async () => {
    const { world, sealings } = await newWorld(2)
    const alice = await attach(world, "alice", sealings[0])
    const bob = await attach(world, "bob", sealings[1])

    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "seen-by-admin"))
    await settle(alice, bob)

    // Alice drops off; Bob writes under the still-current epoch 1.
    alice.transport.connected = false
    bob.engine.transact(() => bob.doc.getMap("pre").set("bob", "admin-missed-this"))
    await settle(alice, bob)
    expect(alice.doc.getMap("pre").get("bob")).toBeUndefined()

    const joinerSealing = await newSealing()
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: joinerSealing.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
    })
    world.keyring.push(...grant.sealed)
    alice.transport.connected = true
    await depositJoinGrant(alice.transport, grant)

    const dave = await attach(world, "dave", joinerSealing)
    const collected = await collectJoinSnapshot({
      transport: dave.transport,
      resourceId: RESOURCE,
      readableEpochs: dave.source.readableEpochs(),
    })
    await dave.engine.applySnapshot(collected!, verifier)
    await dave.engine.sync()
    await settle(dave)

    expect(dave.doc.getMap("pre").get("alice")).toBe("seen-by-admin")
    // Replayed to him, undecryptable, and so still absent.
    expect(dave.doc.getMap("pre").get("bob")).toBeUndefined()
    expect(dave.engine.stats.rejected["unknown-epoch"]).toBeGreaterThan(0)
  })

  it("refuses an admission from a replica behind the relay", async () => {
    const { world, sealings } = await newWorld(2)
    const alice = await attach(world, "alice", sealings[0])
    const bob = await attach(world, "bob", sealings[1])

    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "a"))
    await settle(alice, bob)

    alice.transport.connected = false
    bob.engine.transact(() => bob.doc.getMap("pre").set("bob", "missed"))
    await settle(alice, bob)
    alice.transport.connected = true

    const before = world.keys.currentEpoch
    await expect(
      admitMemberWithSnapshot({
        domain: world.keys,
        joiner: { sealingDid: (await newSealing()).sealingDid },
        doc: alice.doc,
        signingKey: alice.signingKey,
        author: alice.did,
        resourceId: RESOURCE,
        covers: alice.engine.snapshotCoverage(),
        relayVector: await alice.transport.vector(),
      }),
    ).rejects.toThrow(/behind the relay/)

    // Refused before anything was cut.
    expect(world.keys.currentEpoch).toBe(before)

    // After catching up, the same admission succeeds.
    await alice.engine.sync()
    await settle(alice, bob)
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: (await newSealing()).sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
      relayVector: await alice.transport.vector(),
    })
    expect(grant.snapshot).not.toBeNull()
  })

  it("reports which authors a replica is behind on", () => {
    expect(admissionStaleness({ a: 3, b: 1 }, { a: 3, b: 1 })).toEqual({
      stale: false,
      behind: [],
    })
    expect(admissionStaleness({ a: 3 }, { a: 5, b: 2 })).toEqual({
      stale: true,
      behind: ["a", "b"],
    })
    expect(admissionStaleness({ a: 9 }, { a: 3 })).toEqual({ stale: false, behind: [] })
  })

  // The strict property, with a caught-up admin: every pre-existing author must
  // be able to place a subsequent edit.
  it("gives every pre-existing author a working baseline", async () => {
    const { world, sealings } = await newWorld(2)
    const alice = await attach(world, "alice", sealings[0])
    const bob = await attach(world, "bob", sealings[1])

    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "a"))
    await settle(alice, bob)
    bob.engine.transact(() => bob.doc.getMap("pre").set("bob", "b"))
    await settle(alice, bob)

    const joinerSealing = await newSealing()
    const grant = await admitMemberWithSnapshot({
      domain: world.keys,
      joiner: { sealingDid: joinerSealing.sealingDid },
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      resourceId: RESOURCE,
      covers: alice.engine.snapshotCoverage(),
      relayVector: await alice.transport.vector(),
    })
    world.keyring.push(...grant.sealed)
    await depositJoinGrant(alice.transport, grant)
    for (const party of [alice, bob]) {
      await refreshKeysFor(
        party.source,
        world.keys.timeline,
        world.keyring,
        party.sealingDid,
        party.sealingKey,
      )
    }

    const dave = await attach(world, "dave", joinerSealing)
    const collected = await collectJoinSnapshot({
      transport: dave.transport,
      resourceId: RESOURCE,
      readableEpochs: dave.source.readableEpochs(),
    })
    await dave.engine.applySnapshot(collected!, verifier)
    await dave.engine.sync()
    await settle(alice, bob, dave)

    for (const party of [alice, bob]) {
      party.engine.transact(() => party.doc.getMap("post").set(party.name, "after-join"))
      await settle(alice, bob, dave)
    }
    for (const party of [alice, bob]) {
      expect(
        dave.doc.getMap("post").get(party.name),
        `edit from ${party.name} did not apply for the joiner`,
      ).toBe("after-join")
    }
  })
})
