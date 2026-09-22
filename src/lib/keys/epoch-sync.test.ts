/**
 * M5's exit criterion, end to end: content is end-to-end encrypted, and which
 * epoch keys a member holds determines what they can decrypt.
 *
 * Real epoch keys driving the real sync engine over the real relay - no static
 * key provider, no stubbed crypto.
 */

import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateSealingKey, type SealingKey } from "@/lib/crypto"
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
import { FlatKeyring, KeyDomainAdmin, readKeysFor, refreshKeysFor, type SealedEpochKey } from "."
import { KeyringEpochProvider } from "./provider"

const RESOURCE = "notebook:1"

interface Party {
  name: string
  /** The live keyring view - refreshed when shared state moves. */
  source: FlatKeyring
  sealingDid: string
  sealingKey: SealingKey
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

async function newSealing(): Promise<{ sealingKey: SealingKey; sealingDid: string }> {
  const sealingKey = await generateSealingKey()
  return { sealingKey, sealingDid: didFromSealingKey(sealingKey.publicKey) }
}

/** Attach a party to the relay with a keyring view of the shared domain. */
async function attach(world: World, name: string, sealing: Awaited<ReturnType<typeof newSealing>>) {
  const device = await admitDevice(world.admin, { member: `member:${name}`, label: name })
  putDeviceRecord(world.directory, device.record)
  putAdmission(world.directory, device.admission)

  const doc = new Y.Doc()
  const clientId = await bindDocumentClientId(doc, device.key.publicKey)
  const authority = { directory: world.directory, trustedAdminDids: [world.admin.did] }
  const transport = world.relay.attach(name)

  const source = await readKeysFor(
    world.keys.timeline,
    world.keyring,
    sealing.sealingDid,
    sealing.sealingKey,
  )
  const engine = new SyncEngine({
    doc,
    resourceId: RESOURCE,
    author: device.record.did,
    signingKey: device.key,
    clientId,
    transport,
    authors: new DirectoryAuthorResolver(authority),
    policy: new DirectoryMembershipPolicy(authority),
    keys: new KeyringEpochProvider(source),
  })

  const party: Party = {
    name,
    source,
    sealingDid: sealing.sealingDid,
    sealingKey: sealing.sealingKey,
    doc,
    text: doc.getText("content"),
    engine,
    transport,
  }
  return party
}

async function settle(...parties: Party[]): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const party of parties) await party.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const quiet = await Promise.all(parties.map((p) => p.engine.isQuiescent()))
    if (quiet.every(Boolean)) return
  }
}

describe("epoch keys drive what a member can decrypt", () => {
  it("encrypts content end to end and converges between members", async () => {
    const founder = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [founder])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", founder)
    alice.engine.transact(() => alice.text.insert(0, "a secret sentence"))
    await settle(alice)

    // The relay holds ciphertext only.
    const stored = JSON.stringify(world.relay.stored())
    expect(stored).not.toContain("secret")
    expect(world.relay.stored()[0].epoch).toBe(1)
  })

  // History excluded by default, and the consequence that follows from it.
  it("denies a joiner the history written before their epoch", async () => {
    const founder = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [founder])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", founder)
    alice.engine.transact(() => alice.text.insert(0, "before-join "))
    await settle(alice)

    // Bob joins: a chain epoch, sealed only to him.
    const bobSealing = await newSealing()
    const joined = await world.keys.addMember({ sealingDid: bobSealing.sealingDid })
    world.keyring.push(...joined.sealed)

    const bob = await attach(world, "bob", bobSealing)
    await bob.engine.sync()
    await settle(alice, bob)

    // The pre-join envelope was rejected as unreadable, not silently applied.
    expect(bob.engine.stats.rejected["unknown-epoch"]).toBeGreaterThan(0)
    expect(bob.text.toJSON()).toBe("")
    expect(bob.source.readableEpochs()).toEqual([2])
  })

  /**
   * The consequence of excluding history, stated as a test because it is easy
   * to assume otherwise: a joiner is not merely missing old content, they are
   * deaf to that author entirely.
   *
   * Yjs queues structs behind a gap in an author's clock sequence, so once Bob
   * is missing Alice's epoch-1 operations, *nothing* further from Alice applies
   * for him - not even an edit that touches an unrelated part of the document.
   * Decryption succeeds; placement never happens.
   *
   * This makes the joiner snapshot a hard prerequisite rather than an
   * optimisation: without current state re-sealed under their epoch key, a
   * joiner cannot participate at all. That snapshot is M9's.
   */
  it("leaves a joiner deaf to an author whose earlier operations it withheld", async () => {
    const founder = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [founder])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", founder)
    alice.engine.transact(() => alice.text.insert(0, "before-join "))
    await settle(alice)

    const bobSealing = await newSealing()
    world.keyring.push(
      ...(await world.keys.addMember({ sealingDid: bobSealing.sealingDid })).sealed,
    )
    await refreshKeysFor(
      alice.source,
      world.keys.timeline,
      world.keyring,
      alice.sealingDid,
      alice.sealingKey,
    )
    const bob = await attach(world, "bob", bobSealing)

    // An edit that extends the withheld text: decryptable by Bob, but
    // unplaceable, so Yjs holds it pending.
    alice.engine.transact(() => alice.text.insert(alice.text.length, "after-join"))
    await settle(alice, bob)

    expect(alice.source.currentEpoch).toBe(2)
    expect(world.relay.stored().some((e) => e.epoch === 2)).toBe(true)
    expect(bob.engine.stats.applied).toBeGreaterThan(0) // decrypted fine
    expect(bob.text.toJSON()).toBe("") // but cannot be placed

    // Not even an edit touching an unrelated part of the document: the gap is
    // in Alice's clock sequence, so everything of hers queues behind it.
    alice.engine.transact(() => alice.doc.getMap("meta").set("title", "shared"))
    await settle(alice, bob)
    expect(bob.doc.getMap("meta").get("title")).toBeUndefined()

    // A different author, with no gap, applies normally - which isolates the
    // cause to the withheld history rather than to the epoch key.
    const carolSealing = await newSealing()
    world.keyring.push(
      ...(await world.keys.addMember({ sealingDid: carolSealing.sealingDid })).sealed,
    )
    const carol = await attach(world, "carol", carolSealing)
    carol.engine.transact(() => carol.doc.getMap("meta").set("from-carol", "visible"))
    await settle(carol, bob)
    expect(bob.doc.getMap("meta").get("from-carol")).toBe("visible")
  })

  // Removal denies future reads: the removed member keeps everything they had
  // and still cannot open what comes next.
  it("denies a removed member everything after the rotation", async () => {
    const aliceSealing = await newSealing()
    const bobSealing = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [
      { sealingDid: aliceSealing.sealingDid },
      { sealingDid: bobSealing.sealingDid },
    ])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", aliceSealing)
    const bob = await attach(world, "bob", bobSealing)

    alice.engine.transact(() => alice.text.insert(0, "while-bob-was-here "))
    await settle(alice, bob)
    expect(bob.text.toJSON()).toBe("while-bob-was-here ")

    // Bob is removed: rotation, resealed to Alice only.
    const removed = await world.keys.removeMember([{ sealingDid: aliceSealing.sealingDid }])
    world.keyring.push(...removed.sealed)

    // Alice picks up the new epoch and writes under it.
    const aliceAfter = await attach(world, "alice2", aliceSealing)
    aliceAfter.engine.transact(() => aliceAfter.text.insert(0, "after-removal"))
    await settle(aliceAfter, bob)

    // Bob holds his old key and still cannot read the new epoch.
    expect(bob.engine.stats.rejected["unknown-epoch"]).toBeGreaterThan(0)
    expect(bob.text.toJSON()).toBe("while-bob-was-here ")
    expect(world.relay.stored().some((e) => e.epoch === 2)).toBe(true)
  })

  // A member who cannot open the current epoch must not author under a stale
  // key - that would produce envelopes nobody can read.
  it("refuses to author once removed rather than writing unreadable envelopes", async () => {
    const aliceSealing = await newSealing()
    const bobSealing = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [
      { sealingDid: aliceSealing.sealingDid },
      { sealingDid: bobSealing.sealingDid },
    ])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    world.keyring.push(
      ...(await world.keys.removeMember([{ sealingDid: aliceSealing.sealingDid }])).sealed,
    )

    const bobSource = await readKeysFor(
      world.keys.timeline,
      world.keyring,
      bobSealing.sealingDid,
      bobSealing.sealingKey,
    )
    const provider = new KeyringEpochProvider(bobSource)
    await expect(provider.current()).rejects.toThrow(/no readable key for the current epoch/)
  })
})
