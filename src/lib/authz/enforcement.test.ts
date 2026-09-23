/**
 * M7's exit criterion, at both enforcement points:
 *
 *   a correctly signed but unauthorized write is rejected
 *   a non-reader cannot obtain the DEK
 *
 * The first runs through the real sync engine over the real relay; the second
 * through the real keyring, so neither is a unit test of the checker alone.
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
import { KeyDomainAdmin, KeyringEpochProvider, readKeysFor, sealEpochKey } from "@/lib/keys"
import { issueCapability, type Ability, type Capability } from "./capability"
import { CapabilityStore } from "./store"
import {
  CapabilityWritePolicy,
  canAdminister,
  canRead,
  gateReaders,
  requireReaders,
  type CandidateReader,
} from "./enforcement"
import { revokeCapability } from "./revocation"

const RESOURCE = "notebook:1"
const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

interface Party {
  name: string
  did: string
  signingKey: SigningKey
  sealingDid: string
  sealingKey: SealingKey
  doc: Y.Doc
  text: Y.Text
  engine: SyncEngine
  transport: RelayTransport
}

interface World {
  admin: Admin
  owner: { did: string; key: SigningKey }
  directory: Y.Doc
  relay: MemoryRelay
  keys: KeyDomainAdmin
  store: CapabilityStore
}

async function newWorld(): Promise<World> {
  const admin = await newAdmin()
  // The notebook owner is the root of authority for this resource.
  const ownerDevice = await admitDevice(admin, { member: "member:owner", label: "Owner" })
  const owner = { did: ownerDevice.record.did, key: ownerDevice.key }
  const directory = new Y.Doc()
  putDeviceRecord(directory, ownerDevice.record)
  putAdmission(directory, ownerDevice.admission)

  const sealing = await generateSealingKey()
  const { admin: keys } = await KeyDomainAdmin.create(RESOURCE, [
    { sealingDid: didFromSealingKey(sealing.publicKey) },
  ])

  return {
    admin,
    owner,
    directory,
    relay: new MemoryRelay(),
    keys,
    store: new CapabilityStore(owner.did),
  }
}

/** Attach a device, optionally granting it an ability from the owner. */
async function join(
  world: World,
  name: string,
  ability?: Ability,
): Promise<Party & { capability?: Capability }> {
  const device = await admitDevice(world.admin, { member: `member:${name}`, label: name })
  putDeviceRecord(world.directory, device.record)
  putAdmission(world.directory, device.admission)

  let capability: Capability | undefined
  if (ability) {
    capability = await issueCapability({
      signingKey: world.owner.key,
      issuer: world.owner.did,
      audience: device.record.did,
      resource: RESOURCE,
      ability,
      notBefore: T0,
      expiresAt: T0 + 30 * DAY,
    })
    await world.store.add(capability)
  }

  const sealingKey = await generateSealingKey()
  const sealingDid = didFromSealingKey(sealingKey.publicKey)
  const doc = new Y.Doc()
  const clientId = await bindDocumentClientId(doc, device.key.publicKey)
  const transport = world.relay.attach(name)

  // Everyone here holds the content key, deliberately. The write tests are
  // about authorization, so an unauthorized author has to be able to *produce*
  // an envelope - otherwise the check under test is never reached. That is also
  // the realistic shape: a member whose write was withdrawn still holds the
  // epoch keys they were given.
  const source = await readKeysFor(
    world.keys.timeline,
    [await sealEpochKey(RESOURCE, 1, sealingDid, (await world.keys.keyFor(1))!)],
    sealingDid,
    sealingKey,
  )

  const engine = new SyncEngine({
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
    // The enforcement point under test.
    policy: new CapabilityWritePolicy(() => world.store.context(T0)),
    keys: new KeyringEpochProvider(source),
  })

  return {
    name,
    did: device.record.did,
    signingKey: device.key,
    sealingDid,
    sealingKey,
    doc,
    text: doc.getText("content"),
    engine,
    transport,
    ...(capability ? { capability } : {}),
  }
}

/** Parties share a relay, so delivery is live; settle before asserting. */
async function settle(...parties: Party[]): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const party of parties) await party.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const quiet = await Promise.all(parties.map((p) => p.engine.isQuiescent()))
    if (quiet.every(Boolean)) return
  }
}

describe("update acceptance is gated on write", () => {
  // The exit criterion's first half. Mallory's envelope is correctly signed by
  // a real, directory-resolvable device - it fails only on authorization.
  it("rejects a correctly signed envelope from an author holding no write", async () => {
    const world = await newWorld()
    const writer = await join(world, "writer", "write")
    const mallory = await join(world, "mallory")

    mallory.engine.transact(() => mallory.text.insert(0, "unauthorized edit"))
    await settle(mallory, writer)

    // The envelope is real: authored, signed, and by a device the directory
    // resolves. It fails on authorization alone.
    const envelope = mallory.engine.log.all()[0]
    expect(envelope).toBeDefined()
    expect(envelope.author).toBe(mallory.did)

    expect(writer.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
    expect(writer.engine.stats.rejected["bad-signature"]).toBe(0)
    expect(writer.engine.stats.rejected["unknown-author"]).toBe(0)
    expect(writer.engine.stats.applied).toBe(0)
    expect(writer.text.toJSON()).toBe("")
  })

  it("accepts an envelope from an author holding write", async () => {
    const world = await newWorld()
    const alice = await join(world, "alice", "write")
    const bob = await join(world, "bob", "write")

    alice.engine.transact(() => alice.text.insert(0, "authorized"))
    await settle(alice, bob)
    expect(bob.text.toJSON()).toBe("authorized")
    expect(bob.engine.stats.rejected.unauthorized).toBe(0)
  })

  it("rejects a read-only author's write", async () => {
    const world = await newWorld()
    const writer = await join(world, "writer", "write")
    const reader = await join(world, "reader", "read")

    reader.engine.transact(() => reader.text.insert(0, "read-only edit"))
    await settle(reader, writer)

    expect(writer.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
    expect(writer.text.toJSON()).toBe("")
  })

  it("accepts an admin's write, since admin implies write", async () => {
    const world = await newWorld()
    const writer = await join(world, "writer", "write")
    const boss = await join(world, "boss", "admin")

    boss.engine.transact(() => boss.text.insert(0, "by admin"))
    await settle(boss, writer)
    expect(writer.text.toJSON()).toBe("by admin")
  })

  // The policy re-resolves per check, so revocation takes effect immediately
  // rather than at the next restart.
  it("stops accepting once the author's capability is revoked", async () => {
    const world = await newWorld()
    const writer = await join(world, "writer", "write")
    const alice = await join(world, "alice", "write")

    alice.engine.transact(() => alice.text.insert(0, "before revocation"))
    await settle(alice, writer)
    expect(writer.text.toJSON()).toBe("before revocation")

    await world.store.revoke(
      await revokeCapability({
        signingKey: world.owner.key,
        issuer: world.owner.did,
        capabilityCid: alice.capability!.cid,
      }),
      T0,
    )

    alice.engine.transact(() => alice.text.insert(alice.text.length, " after"))
    await settle(alice, writer)

    // Alice authored it; the writer refused it.
    expect(alice.text.toJSON()).toBe("before revocation after")
    expect(writer.text.toJSON()).toBe("before revocation")
    expect(writer.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
  })

  it("surfaces why an edit was refused", async () => {
    const world = await newWorld()
    const denials: { author: string; reason?: string }[] = []
    const policy = new CapabilityWritePolicy(
      () => world.store.context(T0),
      (author, result) => denials.push({ author, reason: result.reason }),
    )

    expect(await policy.canWrite(RESOURCE, "did:key:z6MkStranger")).toBe(false)
    expect(denials).toEqual([{ author: "did:key:z6MkStranger", reason: "no-capability" }])
  })
})

describe("DEK access is gated on read", () => {
  async function candidate(world: World, name: string, ability?: Ability) {
    const party = await join(world, name, ability)
    const reader: CandidateReader = { principal: party.did, sealingDid: party.sealingDid }
    return { party, reader }
  }

  // The exit criterion's second half.
  it("filters a non-reader out of the sealing set", async () => {
    const world = await newWorld()
    const alice = await candidate(world, "alice", "read")
    const mallory = await candidate(world, "mallory")

    const { authorized, denied } = await gateReaders(
      [alice.reader, mallory.reader],
      RESOURCE,
      world.store.context(T0),
    )

    expect(authorized.map((r) => r.principal)).toEqual([alice.party.did])
    expect(denied.map((d) => d.candidate.principal)).toEqual([mallory.party.did])
    expect(denied[0].result.reason).toBe("no-capability")
  })

  // Sealing to only the authorized set is what actually denies the DEK.
  it("never seals an epoch key to a non-reader", async () => {
    const world = await newWorld()
    const alice = await candidate(world, "alice", "read")
    const mallory = await candidate(world, "mallory")

    const { authorized } = await gateReaders(
      [alice.reader, mallory.reader],
      RESOURCE,
      world.store.context(T0),
    )
    const cut = await world.keys.rotate(authorized)

    expect(cut.sealed.map((s) => s.recipient)).toEqual([alice.reader.sealingDid])

    // Alice can open the new epoch; Mallory holds nothing for it.
    const aliceView = await readKeysFor(
      world.keys.timeline,
      cut.sealed,
      alice.party.sealingDid,
      alice.party.sealingKey,
    )
    const malloryView = await readKeysFor(
      world.keys.timeline,
      cut.sealed,
      mallory.party.sealingDid,
      mallory.party.sealingKey,
    )
    expect(await aliceView.keyFor(cut.record.epoch)).toBeDefined()
    expect(await malloryView.keyFor(cut.record.epoch)).toBeUndefined()
    expect(malloryView.readableEpochs()).toEqual([])
  })

  it("admits write and admin holders as readers too", async () => {
    const world = await newWorld()
    const writer = await candidate(world, "writer", "write")
    const boss = await candidate(world, "boss", "admin")

    const { authorized } = await gateReaders(
      [writer.reader, boss.reader],
      RESOURCE,
      world.store.context(T0),
    )
    expect(authorized).toHaveLength(2)
  })

  // Silently sealing to fewer people than asked is worse than failing, on the
  // paths where the caller stated an intended recipient set.
  it("refuses the whole reseal when any candidate lacks read", async () => {
    const world = await newWorld()
    const alice = await candidate(world, "alice", "read")
    const mallory = await candidate(world, "mallory")

    await expect(
      requireReaders([alice.reader, mallory.reader], RESOURCE, world.store.context(T0)),
    ).rejects.toThrow(/no read capability/)

    await expect(
      requireReaders([alice.reader], RESOURCE, world.store.context(T0)),
    ).resolves.toHaveLength(1)
  })

  it("stops treating a revoked reader as authorized", async () => {
    const world = await newWorld()
    const alice = await candidate(world, "alice", "read")

    expect(await canRead(alice.party.did, RESOURCE, world.store.context(T0))).toBe(true)
    await world.store.revoke(
      await revokeCapability({
        signingKey: world.owner.key,
        issuer: world.owner.did,
        capabilityCid: alice.party.capability!.cid,
      }),
      T0,
    )
    expect(await canRead(alice.party.did, RESOURCE, world.store.context(T0))).toBe(false)
  })
})

describe("per-notebook admin with the owner as root", () => {
  it("recognises the owner and refuses a non-admin", async () => {
    const world = await newWorld()
    const boss = await join(world, "boss", "admin")
    const writer = await join(world, "writer", "write")

    // The owner's own authority is rooted by issuing to themselves.
    const selfGrant = await issueCapability({
      signingKey: world.owner.key,
      issuer: world.owner.did,
      audience: world.owner.did,
      resource: RESOURCE,
      ability: "admin",
      depth: 4,
      notBefore: T0,
      expiresAt: T0 + 30 * DAY,
    })
    await world.store.add(selfGrant)

    const context = world.store.context(T0)
    expect(await canAdminister(world.owner.did, RESOURCE, context)).toBe(true)
    expect(await canAdminister(boss.did, RESOURCE, context)).toBe(true)
    expect(await canAdminister(writer.did, RESOURCE, context)).toBe(false)
  })

  // Authority is per resource: an admin of one notebook is nobody in another.
  it("does not carry admin across notebooks", async () => {
    const world = await newWorld()
    const boss = await join(world, "boss", "admin")
    const context = world.store.context(T0)

    expect(await canAdminister(boss.did, RESOURCE, context)).toBe(true)
    expect(await canAdminister(boss.did, "notebook:2", context)).toBe(false)
    expect(await canRead(boss.did, "notebook:2", context)).toBe(false)
  })
})
