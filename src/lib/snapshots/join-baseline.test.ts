/**
 * M6's exit criterion, strictly: after a join snapshot, a subsequent edit from
 * *every* pre-existing author applies - checked per author, not merely that
 * current content is visible.
 *
 * The distinction matters because a joiner can look fine while being deaf to
 * some authors: content from before the join shows up via the snapshot, and one
 * author's later edits place, so a "is the text right?" assertion passes while
 * another author is silently blocked. Only a per-author check catches that.
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
import { createJoinSnapshot, needsJoinSnapshot, rebaselinedAuthors } from "./join"
import { openSnapshot, verifySnapshot, type Snapshot } from "./snapshot"

const RESOURCE = "notebook:1"

interface Party {
  name: string
  did: string
  clientId: number
  sealingDid: string
  sealingKey: SealingKey
  /** Exposed so a test can author a snapshot the engine does not produce. */
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

/** Verifier the engine takes: signature plus author identity. */
const verifier = (snapshot: Snapshot, author: { publicKey: Uint8Array }) =>
  verifySnapshot(snapshot, author.publicKey)

describe("the joiner snapshot re-establishes a per-author causal baseline", () => {
  it("lets a subsequent edit from EVERY pre-existing author apply", async () => {
    // Three founders, all of whom write before anyone joins.
    const sealings = await Promise.all([newSealing(), newSealing(), newSealing()])
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

    const names = ["alice", "bob", "carol"]
    const founders: Party[] = []
    for (const [index, name] of names.entries()) {
      founders.push(await attach(world, name, sealings[index]))
    }

    // Every founder writes, so every one of them has a clock sequence a joiner
    // would otherwise have a gap in.
    for (const founder of founders) {
      founder.engine.transact(() => founder.doc.getMap("pre").set(founder.name, "before-join"))
      await settle(...founders)
    }
    for (const founder of founders) {
      expect(founder.doc.getMap("pre").size).toBe(3)
    }

    // A joiner arrives: a chain epoch, sealed only to them.
    const daveSealing = await newSealing()
    world.keyring.push(
      ...(await world.keys.addMember({ sealingDid: daveSealing.sealingDid })).sealed,
    )
    for (const founder of founders) {
      await refreshKeysFor(
        founder.source,
        world.keys.timeline,
        world.keyring,
        founder.sealingDid,
        founder.sealingKey,
      )
    }
    const dave = await attach(world, "dave", daveSealing)

    // Alice produces the join snapshot, sealed under the NEW epoch.
    const producer = founders[0]
    expect(needsJoinSnapshot(producer.doc)).toBe(true)
    const epoch = producer.source.currentEpoch
    const snapshot = await createJoinSnapshot({
      doc: producer.doc,
      signingKey: producer.signingKey,
      author: producer.did,
      domain: RESOURCE,
      resourceId: RESOURCE,
      epoch,
      dek: (await producer.source.keyFor(epoch))!,
      covers: producer.engine.snapshotCoverage(),
    })

    // It re-baselines all three founders, not just its producer.
    const state = await openSnapshot(snapshot, (await dave.source.keyFor(epoch))!)
    expect(rebaselinedAuthors(state)).toEqual(
      founders.map((f) => f.clientId).sort((a, b) => a - b),
    )

    expect(await dave.engine.applySnapshot(snapshot, verifier)).toBe(true)
    expect(dave.doc.getMap("pre").size).toBe(3)

    // THE STRICT CHECK: a subsequent edit from each pre-existing author, one at
    // a time, must apply for Dave.
    for (const founder of founders) {
      founder.engine.transact(() =>
        founder.doc.getMap("post").set(founder.name, "after-join"),
      )
      await settle(...founders, dave)
    }

    for (const founder of founders) {
      expect(
        dave.doc.getMap("post").get(founder.name),
        `edit from ${founder.name} did not apply for the joiner`,
      ).toBe("after-join")
    }
    expect(dave.doc.getMap("post").size).toBe(3)
  })

  // The failure the strict check exists to catch: without the snapshot, a
  // joiner may see *some* authors and be silently deaf to others.
  it("without the snapshot, pre-existing authors stay blocked", async () => {
    const aliceSealing = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [
      { sealingDid: aliceSealing.sealingDid },
    ])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", aliceSealing)
    alice.engine.transact(() => alice.doc.getMap("pre").set("alice", "before-join"))
    await settle(alice)

    const daveSealing = await newSealing()
    world.keyring.push(
      ...(await world.keys.addMember({ sealingDid: daveSealing.sealingDid })).sealed,
    )
    await refreshKeysFor(
      alice.source,
      world.keys.timeline,
      world.keyring,
      alice.sealingDid,
      alice.sealingKey,
    )
    const dave = await attach(world, "dave", daveSealing)

    // No snapshot. Alice edits; Dave decrypts but cannot place.
    alice.engine.transact(() => alice.doc.getMap("post").set("alice", "after-join"))
    await settle(alice, dave)

    expect(dave.engine.stats.applied).toBeGreaterThan(0)
    expect(dave.doc.getMap("post").get("alice")).toBeUndefined()
  })

  it("advances the delivery vector so unreadable history is not re-requested", async () => {
    const aliceSealing = await newSealing()
    const admin = await newAdmin()
    const { admin: keys, sealed } = await KeyDomainAdmin.create(RESOURCE, [
      { sealingDid: aliceSealing.sealingDid },
    ])
    const world: World = {
      admin,
      directory: new Y.Doc(),
      relay: new MemoryRelay(),
      keys,
      keyring: [...sealed],
    }

    const alice = await attach(world, "alice", aliceSealing)
    alice.engine.transact(() => alice.text.insert(0, "one "))
    await settle(alice)
    alice.engine.transact(() => alice.text.insert(alice.text.length, "two"))
    await settle(alice)

    const daveSealing = await newSealing()
    world.keyring.push(
      ...(await world.keys.addMember({ sealingDid: daveSealing.sealingDid })).sealed,
    )
    await refreshKeysFor(
      alice.source,
      world.keys.timeline,
      world.keyring,
      alice.sealingDid,
      alice.sealingKey,
    )
    const dave = await attach(world, "dave", daveSealing)

    const epoch = alice.source.currentEpoch
    const snapshot = await createJoinSnapshot({
      doc: alice.doc,
      signingKey: alice.signingKey,
      author: alice.did,
      domain: RESOURCE,
      resourceId: RESOURCE,
      epoch,
      dek: (await alice.source.keyFor(epoch))!,
      covers: alice.engine.snapshotCoverage(),
    })

    expect(dave.engine.deliveryVector()[alice.did] ?? 0).toBe(0)
    await dave.engine.applySnapshot(snapshot, verifier)
    expect(dave.engine.deliveryVector()[alice.did]).toBe(2)

    // A catch-up now pulls nothing it could never read.
    const before = dave.engine.stats.rejected["unknown-epoch"]
    await dave.engine.sync()
    await settle(alice, dave)
    expect(dave.engine.stats.rejected["unknown-epoch"]).toBe(before)
    expect(dave.text.toJSON()).toBe("one two")
  })

  it("is unnecessary for a join to an empty notebook", () => {
    expect(needsJoinSnapshot(new Y.Doc())).toBe(false)
    const doc = new Y.Doc()
    doc.getText("content").insert(0, "x")
    expect(needsJoinSnapshot(doc)).toBe(true)
  })
})
