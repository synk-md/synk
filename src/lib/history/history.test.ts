import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSigningKey, type Bytes, type SigningKey } from "@/lib/crypto"
import { createUser, deriveClientId, didFromSigningKey } from "@/lib/identity"
import { createSnapshot, SnapshotStore, type Snapshot } from "@/lib/snapshots"
import { EnvelopeLog, makeEnvelope } from "@/lib/sync"
import { admitDevice, asAdmitted, newAdmin } from "@/test/identity-fixtures"

import { resolveAttribution } from "./attribution"
import { DEFAULT_CADENCE, SnapshotCadence } from "./cadence"
import { planDrop } from "./retention"
import { applyRestore, planRestore, verifyRestoreRecord, type RestoreRecord } from "./restore"
import { buildTimeline, historyHorizon } from "./timeline"

const T0 = 1_700_000_000_000
const MINUTE = 60 * 1000
const RESOURCE = "notebook:travel"
const DOMAIN = "notebook:travel"
const DEK = new Uint8Array(32).fill(9)

interface Party {
  key: SigningKey
  did: string
  clientId: number
}

async function party(): Promise<Party> {
  const key = await generateSigningKey()
  const did = didFromSigningKey(key.publicKey)
  return { key, did, clientId: await deriveClientId(key.publicKey) }
}

/** A keyring view that can open exactly the listed epochs. */
function keysFor(epochs: readonly number[]) {
  return {
    keyFor: (epoch: number) => Promise.resolve(epochs.includes(epoch) ? DEK : undefined),
    readableEpochs: () => [...epochs],
  }
}

async function snapshotOf(
  author: Party,
  doc: Y.Doc,
  options: {
    epoch?: number
    createdAt?: number
    kind?: Snapshot["kind"]
    label?: string
    parent?: string | null
    covers?: Record<string, number>
  } = {},
): Promise<Snapshot> {
  return createSnapshot({
    signingKey: author.key,
    author: author.did,
    domain: DOMAIN,
    resourceId: RESOURCE,
    kind: options.kind ?? "automatic",
    epoch: options.epoch ?? 1,
    dek: DEK,
    state: Y.encodeStateAsUpdate(doc),
    covers: options.covers ?? {},
    parent: options.parent ?? null,
    createdAt: options.createdAt ?? T0,
    ...(options.label === undefined ? {} : { label: options.label }),
  })
}

/* ---- attribution --------------------------------------------------------- */

describe("resolveAttribution", () => {
  it("resolves a device key to its admin-attested name", async () => {
    const admin = await newAdmin()
    const device = await admitDevice(admin, { member: "member:ada", label: "Ada Lovelace" })
    const user = createUser("member:ada", [asAdmitted(device)])

    const attribution = resolveAttribution(device.record.did, [user])

    expect(attribution.label).toBe("Ada Lovelace")
    expect(attribution.member).toBe("member:ada")
    expect(attribution.unknown).toBe(false)
    // An admission is not a verified identity.
    expect(attribution.assurance).toBe("invited")
  })

  /**
   * `userLabel` returns a value rather than throwing so this path can render a
   * conflict. A timeline must not be taken down by one disputed byline.
   */
  it("shows conflicting attested names as unverified instead of throwing", async () => {
    const adminA = await newAdmin()
    const adminB = await newAdmin()
    const first = await admitDevice(adminA, { member: "member:ada", label: "Ada" })
    const second = await admitDevice(adminB, { member: "member:ada", label: "A. Lovelace" })
    const user = createUser("member:ada", [asAdmitted(first), asAdmitted(second)])

    const attribution = resolveAttribution(first.record.did, [user])

    expect(attribution.conflict).toEqual(["A. Lovelace", "Ada"])
    expect(attribution.assurance).toBe("self-asserted")
    expect(attribution.label).toContain("Ada")
  })

  it("falls back to the key rather than inventing a name", async () => {
    const stranger = await party()
    const attribution = resolveAttribution(stranger.did, [])

    expect(attribution.unknown).toBe(true)
    expect(attribution.member).toBeNull()
    expect(attribution.label).toContain("Unknown device")
    expect(attribution.author).toBe(stranger.did)
  })
})

/* ---- the timeline -------------------------------------------------------- */

describe("buildTimeline", () => {
  async function fixture() {
    const admin = await newAdmin()
    const device = await admitDevice(admin, { member: "member:ada", label: "Ada" })
    const user = createUser("member:ada", [asAdmitted(device)])
    const author: Party = {
      key: device.key,
      did: device.record.did,
      clientId: device.record.clientId,
    }

    const doc = new Y.Doc()
    doc.getText("body").insert(0, "hello")

    const old = await snapshotOf(author, doc, { epoch: 1, createdAt: T0 })
    const recent = await snapshotOf(author, doc, {
      epoch: 3,
      createdAt: T0 + MINUTE,
      kind: "checkpoint",
      label: "Before the rewrite",
    })
    return { user, author, old, recent }
  }

  it("lists newest first, with attribution on every point", async () => {
    const { user, old, recent } = await fixture()
    const store = new SnapshotStore()
    store.add(old)
    store.add(recent)

    const points = buildTimeline({
      entries: store.entries(),
      users: [user],
      readableEpochs: [1, 3],
    })

    expect(points.map((point) => point.id)).toEqual([recent.id, old.id])
    expect(points[0].attribution.label).toBe("Ada")
    expect(points[0].label).toBe("Before the rewrite")
  })

  /** The history exists; pretending otherwise would be a lie. */
  it("lists a point outside visible history but refuses to call it restorable", async () => {
    const { user, old, recent } = await fixture()
    const store = new SnapshotStore()
    store.add(old)
    store.add(recent)

    const points = buildTimeline({
      entries: store.entries(),
      users: [user],
      readableEpochs: [3],
    })

    const before = points.find((point) => point.id === old.id)
    expect(before).toBeDefined()
    expect(before?.restorable).toBe(false)
    expect(before?.blocker).toBe("outside-visible-history")
    expect(historyHorizon(points)?.id).toBe(old.id)
  })

  it("marks a point whose payload was let go as needing a fetch, not as gone", async () => {
    const { user, author } = await fixture()
    const doc = new Y.Doc()
    doc.getText("body").insert(0, "x")

    const store = new SnapshotStore({ window: 1, keepPinned: false })
    for (let i = 0; i < 3; i += 1) {
      store.add(await snapshotOf(author, doc, { createdAt: T0 + i * MINUTE }))
    }

    const points = buildTimeline({ entries: store.entries(), users: [user], readableEpochs: [1] })
    const degraded = points.filter((point) => !point.materialised)

    expect(degraded.length).toBeGreaterThan(0)
    expect(degraded[0].blocker).toBe("payload-archived")
    // The chain stays walkable: id, parent and author survive degradation.
    expect(degraded[0].attribution.label).toBe("Ada")
  })

  it("will not offer a restore to where the document already is", async () => {
    const { user, old, recent } = await fixture()
    const points = buildTimeline({
      entries: [
        { materialised: true, ...old },
        { materialised: true, ...recent },
      ],
      users: [user],
      readableEpochs: [1, 3],
      currentId: recent.id,
    })

    expect(points.find((point) => point.id === recent.id)?.blocker).toBe("current")
  })
})

/* ---- restore ------------------------------------------------------------- */

describe("restore", () => {
  async function scenario() {
    const ada = await party()
    const bob = await party()

    // Bob writes the original paragraph.
    const doc = new Y.Doc()
    doc.clientID = bob.clientId
    doc.getText("body").insert(0, "the original paragraph")

    const point = await snapshotOf(bob, doc, { epoch: 1, createdAt: T0 })

    // Ada then rewrites the middle of it.
    doc.clientID = ada.clientId
    doc.getText("body").delete(4, 8)
    doc.getText("body").insert(4, "replacement")

    return { ada, bob, doc, point }
  }

  it("moves the document forward to the target content", async () => {
    const { ada, doc, point } = await scenario()
    expect(doc.getText("body").toJSON()).toBe("the replacement paragraph")

    await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: {},
      transact: (fn) => doc.transact(fn),
      restoredAt: T0 + MINUTE,
    })

    expect(doc.getText("body").toJSON()).toBe("the original paragraph")
  })

  /**
   * The whole point of the prefix/suffix trim. A wholesale replace would be
   * simpler and would put the restorer's client id on every character.
   */
  it("leaves unchanged text owned by its original author", async () => {
    const { ada, bob, doc, point } = await scenario()

    await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: {},
      transact: (fn) => doc.transact(fn),
    })

    // "the " and " paragraph" were never touched, so Bob's structs survive.
    const clients = new Set<number>()
    let item = (doc.getText("body") as unknown as { _start: { deleted: boolean; id: { client: number }; right: unknown } | null })._start
    while (item) {
      if (!item.deleted) clients.add(item.id.client)
      item = item.right as typeof item
    }
    expect(clients.has(bob.clientId)).toBe(true)
    expect(clients.has(ada.clientId)).toBe(true)
  })

  /** Yjs cannot resurrect a tombstone, so provenance is recorded out of band. */
  it("records who originally wrote the content it brought back", async () => {
    const { ada, bob, doc, point } = await scenario()

    const { record } = await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: { [bob.did]: 4 },
      transact: (fn) => doc.transact(fn),
    })

    expect(record.actor).toBe(ada.did)
    expect(record.regions.map((region) => region.originClientId)).toContain(bob.clientId)
    expect(record.target).toBe(point.id)
    expect(record.targetStateHash).toBe(point.stateHash)
    // The position before the restore, so this is itself reversible.
    expect(record.supersedes).toEqual({ [bob.did]: 4 })
  })

  it("signs the record, and refuses a tampered one", async () => {
    const { ada, doc, point } = await scenario()
    const { record } = await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: {},
      transact: (fn) => doc.transact(fn),
    })

    expect(await verifyRestoreRecord(record)).toBe(true)

    const forged: RestoreRecord = { ...record, target: "some-other-snapshot" }
    expect(await verifyRestoreRecord(forged)).toBe(false)
  })

  /** There is no path to recovering content from before you joined. */
  it("refuses a target sealed under an epoch the actor cannot open", async () => {
    const { doc, point } = await scenario()

    await expect(
      planRestore({ doc, target: point, keys: keysFor([2, 3]) }),
    ).rejects.toThrow(/visible history/)
  })

  it("refuses when the actor may not write here", async () => {
    const { ada, doc, point } = await scenario()

    await expect(
      applyRestore({
        doc,
        target: point,
        keys: keysFor([1]),
        signingKey: ada.key,
        actor: ada.did,
        canWrite: () => false,
        supersedes: {},
        transact: (fn) => doc.transact(fn),
      }),
    ).rejects.toThrow(/not authorized/)
  })

  it("writes through the caller's transaction, never around it", async () => {
    const { ada, doc, point } = await scenario()
    let used = false

    await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: {},
      transact: (fn) => {
        used = true
        doc.transact(fn)
      },
    })

    expect(used).toBe(true)
  })

  it("reports a restore to where the document already is as a no-op", async () => {
    const bob = await party()
    const doc = new Y.Doc()
    doc.clientID = bob.clientId
    doc.getText("body").insert(0, "unchanged")
    const point = await snapshotOf(bob, doc, { epoch: 1 })

    const plan = await planRestore({ doc, target: point, keys: keysFor([1]) })

    expect(plan.noop).toBe(true)
    expect(plan.changed).toBe(0)
  })

  it("plans without touching the live document", async () => {
    const { doc, point } = await scenario()
    const before = doc.getText("body").toJSON()

    const plan = await planRestore({ doc, target: point, keys: keysFor([1]) })

    expect(plan.changed).toBeGreaterThan(0)
    expect(doc.getText("body").toJSON()).toBe(before)
  })

  it("restores structured content, not only text", async () => {
    const ada = await party()
    const doc = new Y.Doc()
    doc.clientID = ada.clientId
    doc.getMap("meta").set("title", "First title")
    doc.getArray("tags").insert(0, ["a", "b"])
    const point = await snapshotOf(ada, doc, { epoch: 1 })

    doc.getMap("meta").set("title", "Second title")
    doc.getMap("meta").set("extra", "added later")
    doc.getArray("tags").insert(2, ["c"])

    await applyRestore({
      doc,
      target: point,
      keys: keysFor([1]),
      signingKey: ada.key,
      actor: ada.did,
      canWrite: () => true,
      supersedes: {},
      transact: (fn) => doc.transact(fn),
    })

    expect(doc.getMap("meta").get("title")).toBe("First title")
    expect(doc.getMap("meta").has("extra")).toBe(false)
    expect(doc.getArray("tags").toJSON()).toEqual(["a", "b"])
  })
})

/* ---- cadence ------------------------------------------------------------- */

describe("SnapshotCadence", () => {
  /** A boundary without a snapshot strands the next joiner. */
  it("is always due at an epoch boundary, even inside the rate floor", () => {
    const cadence = new SnapshotCadence(DEFAULT_CADENCE)
    cadence.markTaken(T0, 1)

    expect(cadence.due(T0 + 1000)).toBeNull()
    cadence.noteEpoch(2)
    expect(cadence.due(T0 + 1000)).toBe("epoch")
  })

  it("becomes due on activity", () => {
    const cadence = new SnapshotCadence({ everyUpdates: 3, everyMs: 10 * MINUTE })
    cadence.markTaken(T0, 1)

    cadence.noteUpdate()
    cadence.noteUpdate()
    expect(cadence.due(T0 + MINUTE)).toBeNull()
    cadence.noteUpdate()
    expect(cadence.due(T0 + MINUTE)).toBe("activity")
  })

  /** A long slow edit never trips a count, so time has to be a trigger too. */
  it("becomes due on elapsed time even with few updates", () => {
    const cadence = new SnapshotCadence({ everyUpdates: 1000, everyMs: 5 * MINUTE })
    cadence.markTaken(T0, 1)
    cadence.noteUpdate()

    expect(cadence.due(T0 + MINUTE)).toBeNull()
    expect(cadence.due(T0 + 6 * MINUTE)).toBe("time")
  })

  /** A snapshot identical to the last one is pure cost. */
  it("is never due on time alone with nothing written", () => {
    const cadence = new SnapshotCadence({ everyUpdates: 5, everyMs: MINUTE })
    cadence.markTaken(T0, 1)

    expect(cadence.due(T0 + 60 * MINUTE)).toBeNull()
    expect(cadence.idle).toBe(true)
  })

  it("resets once one is taken", () => {
    const cadence = new SnapshotCadence({ everyUpdates: 2, everyMs: MINUTE })
    cadence.noteUpdate()
    cadence.noteUpdate()
    expect(cadence.due(T0)).toBe("activity")

    cadence.markTaken(T0, 1)
    expect(cadence.due(T0)).toBeNull()
    expect(cadence.snapshot.updatesSince).toBe(0)
  })

  it("does not repeat an epoch it has already snapshotted", () => {
    const cadence = new SnapshotCadence()
    cadence.noteEpoch(2)
    cadence.markTaken(T0, 2)
    cadence.noteEpoch(2)

    expect(cadence.due(T0 + 60 * MINUTE)).toBeNull()
  })
})

/* ---- droppable envelopes ------------------------------------------------- */

describe("planDrop", () => {
  async function logWith(author: Party, count: number): Promise<EnvelopeLog> {
    const log = new EnvelopeLog()
    for (let seq = 1; seq <= count; seq += 1) {
      log.append(
        await makeEnvelope({
          signingKey: author.key,
          author: author.did,
          seq,
          resourceId: RESOURCE,
          epoch: 1,
          dek: DEK,
          update: new Uint8Array([seq]) as Bytes,
        }),
      )
    }
    return log
  }

  it("drops what an established snapshot covers, and keeps the rest", async () => {
    const ada = await party()
    const log = await logWith(ada, 5)
    const doc = new Y.Doc()
    const snapshot = await snapshotOf(ada, doc, { covers: { [ada.did]: 3 } })

    const plan = planDrop({
      log,
      entries: [{ materialised: true, ...snapshot }],
      established: new Set([snapshot.id]),
    })

    expect(plan.drop.map((ref) => ref.seq)).toEqual([1, 2, 3])
    expect(plan.kept.map((entry) => entry.ref.seq)).toEqual([4, 5])
    expect(plan.behind).toBe(snapshot.id)
  })

  /**
   * Merge correctness rests on the producer's attestation, so a client that has
   * not applied a snapshot has no grounds to throw away what would check it.
   */
  it("drops nothing behind a snapshot it has not established", async () => {
    const ada = await party()
    const log = await logWith(ada, 3)
    const doc = new Y.Doc()
    const snapshot = await snapshotOf(ada, doc, { covers: { [ada.did]: 3 } })

    const plan = planDrop({
      log,
      entries: [{ materialised: true, ...snapshot }],
      established: new Set(),
    })

    expect(plan.drop).toHaveLength(0)
    expect(plan.behind).toBeNull()
    expect(plan.kept[0].reason).toBe("unestablished")
  })

  it("drops nothing behind a marker whose payload is gone", async () => {
    const ada = await party()
    const log = await logWith(ada, 2)
    const doc = new Y.Doc()
    const snapshot = await snapshotOf(ada, doc, { covers: { [ada.did]: 2 } })

    const plan = planDrop({
      log,
      entries: [
        {
          materialised: false,
          id: snapshot.id,
          domain: DOMAIN,
          resourceId: RESOURCE,
          kind: "automatic",
          author: ada.did,
          epoch: 1,
          covers: { [ada.did]: 2 },
          parent: null,
          stateHash: snapshot.stateHash,
          createdAt: T0,
        },
      ],
      established: new Set([snapshot.id]),
    })

    expect(plan.drop).toHaveLength(0)
    expect(plan.kept[0].reason).toBe("not-materialised")
  })

  it("keeps everything when there is no snapshot at all", async () => {
    const ada = await party()
    const log = await logWith(ada, 2)

    const plan = planDrop({ log, entries: [], established: new Set() })

    expect(plan.drop).toHaveLength(0)
    expect(plan.kept.every((entry) => entry.reason === "not-covered")).toBe(true)
  })

  /** Deepest established coverage, not newest: an unestablished later one authorises nothing. */
  it("uses the deepest established snapshot rather than the newest", async () => {
    const ada = await party()
    const log = await logWith(ada, 6)
    const doc = new Y.Doc()
    const older = await snapshotOf(ada, doc, { covers: { [ada.did]: 4 }, createdAt: T0 })
    const newer = await snapshotOf(ada, doc, {
      covers: { [ada.did]: 6 },
      createdAt: T0 + MINUTE,
      parent: older.id,
    })

    const plan = planDrop({
      log,
      entries: [
        { materialised: true, ...older },
        { materialised: true, ...newer },
      ],
      established: new Set([older.id]),
    })

    expect(plan.behind).toBe(older.id)
    expect(plan.drop).toHaveLength(4)
  })
})
