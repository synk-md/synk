import * as Y from "yjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { IndexeddbPersistence } from "y-indexeddb"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { verifyRestoreRecord, type RestoreRecord } from "@/lib/history"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { MemoryRelay } from "@/lib/sync"

import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine } from "./note-sync"
import { foundNotebookWorkspace } from "./notebook-workspace"
import { NoteHistory, RESTORE_MAP } from "./note-history"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** Stands in for the note's own IndexedDB: its custom key-value store. */
function aStore(): IndexeddbPersistence {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(values.get(key)),
    set: (key: string, value: unknown) => {
      values.set(key, value)
      return Promise.resolve(value)
    },
  } as unknown as IndexeddbPersistence
}

async function anOwner() {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const keys = await readNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner, owner: owner.did })
  return { directory, owner, keyring: keys.keyring! }
}

/** What the editor writes: paragraphs in the collaboration fragment. */
function write(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment("default")
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText(text)])
    fragment.insert(0, [paragraph])
  })
}
const read = (doc: Y.Doc) => doc.getXmlFragment("default").toJSON().replace(/<[^>]+>/g, "")

function aHistory(
  device: DeviceIdentity,
  keyring: ReadKeySource,
  doc: Y.Doc,
  options: { relay?: MemoryRelay; keep?: number } = {},
) {
  const transport = options.relay?.attach(device.did)
  return new NoteHistory({
    notebookId: NOTEBOOK,
    noteId: "kyoto",
    doc,
    storage: aStore(),
    device,
    keys: () => keyring,
    ...(transport ? { transport: () => transport } : {}),
    ...(options.keep === undefined ? {} : { keep: options.keep }),
  })
}

describe("a note's history", () => {
  it("restores the note to a named checkpoint", async () => {
    const { owner, keyring } = await anOwner()
    const doc = new Y.Doc()
    doc.clientID = owner.clientId
    const history = aHistory(owner, keyring, doc)

    write(doc, "First draft.")
    const checkpoint = await history.take("checkpoint", "Before the rewrite")
    write(doc, "Rewritten entirely.")
    expect(read(doc)).toBe("Rewritten entirely.")

    const plan = await history.plan(checkpoint!.id)
    expect(plan.noop).toBe(false)
    await history.restore(checkpoint!.id)

    expect(read(doc)).toBe("First draft.")
  })

  /** A restore is an edit someone made, so who made it and what it brought back are kept. */
  it("records the restore in the note, signed by whoever restored", async () => {
    const { owner, keyring } = await anOwner()
    const doc = new Y.Doc()
    doc.clientID = owner.clientId
    const history = aHistory(owner, keyring, doc)
    write(doc, "Kept.")
    const point = await history.take("checkpoint", "Kept")
    write(doc, "Changed.")
    await history.restore(point!.id)

    const records = [...doc.getMap<RestoreRecord>(RESTORE_MAP).values()]
    expect(records).toHaveLength(1)
    expect(records[0].actor).toBe(owner.did)
    expect(await verifyRestoreRecord(records[0])).toBe(true)
  })

  it("does not take an automatic point when nothing changed", async () => {
    const { owner, keyring } = await anOwner()
    const doc = new Y.Doc()
    const history = aHistory(owner, keyring, doc)
    write(doc, "Same.")

    expect(await history.take("automatic")).not.toBeNull()
    expect(await history.take("automatic")).toBeNull()
    write(doc, "Different.")
    expect(await history.take("automatic")).not.toBeNull()
  })

  /** Named on purpose, so never tidied away; automatic ones are a convenience. */
  it("keeps every checkpoint and only the newest automatic points", async () => {
    const { owner, keyring } = await anOwner()
    const doc = new Y.Doc()
    const history = aHistory(owner, keyring, doc, { keep: 2 })

    write(doc, "one")
    await history.take("checkpoint", "The first")
    for (const text of ["two", "three", "four", "five"]) {
      write(doc, text)
      await history.take("automatic")
    }

    const kept = await history.list()
    expect(kept.filter((point) => point.kind === "checkpoint").map((point) => point.label)).toEqual(["The first"])
    expect(kept.filter((point) => point.kind === "automatic")).toHaveLength(2)
  })

  it("is sealed, so the relay holding a shared note's history cannot read it", async () => {
    const { owner, keyring } = await anOwner()
    const relay = new MemoryRelay()
    const doc = new Y.Doc()
    const history = aHistory(owner, keyring, doc, { relay })
    write(doc, "Our secret plans for Kyoto.")
    await history.take("checkpoint", "Plans")

    expect(relay.archived(history.resourceId)).toHaveLength(1)
    expect(JSON.stringify(relay.archived(history.resourceId))).not.toContain("Kyoto")
  })

  /** Everyone working on a shared note sees the same timeline. */
  it("shows a shared note's points to every device that holds its keys", async () => {
    const { owner, keyring } = await anOwner()
    const relay = new MemoryRelay()
    const doc = new Y.Doc()
    write(doc, "Written on the laptop.")
    await aHistory(owner, keyring, doc, { relay }).take("checkpoint", "From the laptop")

    // Another device of the same keys, with its own storage and its own copy.
    const elsewhere = new Y.Doc()
    const points = await aHistory(owner, keyring, elsewhere, { relay }).list()
    expect(points.map((point) => point.label)).toEqual(["From the laptop"])

    const other = aHistory(owner, keyring, elsewhere, { relay })
    // Unbound roots are reported, not guessed at.
    expect((await other.plan(points[0].id)).skipped).toEqual(["default"])
    // As the editor does on opening a note.
    elsewhere.getXmlFragment("default")
    expect((await other.plan(points[0].id)).skipped).toEqual([])
    await other.restore(points[0].id)
    expect(read(elsewhere)).toBe("Written on the laptop.")
  })

  it("takes nothing without a key to seal it under", async () => {
    const { owner } = await anOwner()
    const history = new NoteHistory({
      notebookId: NOTEBOOK,
      noteId: "kyoto",
      doc: new Y.Doc(),
      storage: aStore(),
      device: owner,
      keys: () => null,
    })
    expect(await history.take("checkpoint", "Nope")).toBeNull()
  })
})

/** A shared note's timeline is what its envelopes say happened. */
describe("a shared note's sessions", () => {
  afterEach(() => vi.restoreAllMocks())

  it("restores the note to where a session left it", async () => {
    const { directory, owner, keyring } = await anOwner()
    const relay = new MemoryRelay()
    const doc = new Y.Doc()
    doc.clientID = owner.clientId
    doc.getXmlFragment("default")
    const engine = createNoteSyncEngine({
      doc,
      notebookId: NOTEBOOK,
      noteId: "kyoto",
      index: directory,
      owner: owner.did,
      author: owner.did,
      signingKey: owner.signingKey,
      clientId: owner.clientId,
      keys: liveKeys(() => keyring),
      transport: relay.attach(owner.did),
    })
    const clock = vi.spyOn(Date, "now")
    const writeAt = async (at: number, text: string) => {
      clock.mockReturnValue(at)
      engine.transact(() => write(doc, text))
      await engine.flush()
    }
    // An hour apart, so two sessions of one person's writing.
    await writeAt(1_000_000, "The morning's plan.")
    await writeAt(1_000_000 + 60 * 60 * 1000, "The evening's rewrite.")
    clock.mockRestore()

    const history = aHistory(owner, keyring, doc, { relay })
    const [morning, evening] = await history.sessions()
    expect(evening.author).toBe(owner.did)
    expect((await history.plan(evening.id)).noop).toBe(true)

    const record = await history.restore(morning.id)
    expect(read(doc)).toBe("The morning's plan.")
    expect(record.target).toBe(morning.id)
    expect(await verifyRestoreRecord(record)).toBe(true)
  })
})
