import * as Y from "yjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { IndexeddbPersistence } from "y-indexeddb"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { LoopbackLink, RelayConnection, RelayServer } from "@/lib/relay"
import { DEFAULT_QUOTA, type RelayQuota } from "@/lib/relay/server-store"
import { createSnapshot } from "@/lib/snapshots"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { resolveOwnership } from "./genesis"
import { foundNotebookKeys, keyDomainFor, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, genesisClaims } from "./notebook-workspace"
import { NoteHistory } from "./note-history"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"
import { openSyncSession } from "./sync-session"

const RELAY_ID = "did:relay:test"
const NOTEBOOK = "travel"
const RESOURCE = noteResourceId(NOTEBOOK, "kyoto")
const DAY = 24 * 60 * 60 * 1000
const PRUNE = { olderThanMs: 30 * DAY }

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function aNotebook(quota?: RelayQuota) {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const ada = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc: directory, secret, device: ada })
  await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })

  const clock = { now: Date.now() }
  const server = new RelayServer({
    relayId: RELAY_ID,
    now: () => clock.now,
    prune: PRUNE,
    ...(quota ? { quota } : {}),
  })
  return { directory, owner, ada, server, clock }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

function connect(notebook: Notebook, device: DeviceIdentity): RelayConnection {
  const [clientLink, serverLink] = LoopbackLink.pair()
  notebook.server.accept(serverLink)
  return new RelayConnection({
    link: clientLink,
    relayId: RELAY_ID,
    did: device.did,
    signingKey: device.signingKey,
    timeoutMs: 2000,
  })
}

async function keysOf(notebook: Notebook, device: DeviceIdentity): Promise<ReadKeySource> {
  const keys = await readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })
  if (!keys.keyring) throw new Error(`no keys for ${device.did}`)
  return keys.keyring
}

/** What the editor writes: paragraphs in the collaboration fragment. */
function write(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment("default")
  const paragraph = new Y.XmlElement("paragraph")
  paragraph.insert(0, [new Y.XmlText(text)])
  fragment.insert(fragment.length, [paragraph])
}
const read = (doc: Y.Doc) => doc.getXmlFragment("default").toJSON().replace(/<[^>]+>/g, "")

/** The owner's laptop: writing to the relay, and able to take an anchor. */
async function theOwner(notebook: Notebook) {
  const connection = connect(notebook, notebook.owner)
  const transport = connection.transportFor(RESOURCE)
  const keys = await keysOf(notebook, notebook.owner)
  const doc = new Y.Doc()
  doc.clientID = notebook.owner.clientId
  doc.getXmlFragment("default")
  const engine = createNoteSyncEngine({
    doc,
    notebookId: NOTEBOOK,
    noteId: "kyoto",
    index: notebook.directory,
    owner: notebook.owner.did,
    author: notebook.owner.did,
    signingKey: notebook.owner.signingKey,
    clientId: notebook.owner.clientId,
    keys: liveKeys(() => keys),
    transport,
  })
  const ownership = await resolveOwnership(genesisClaims(notebook.directory))
  return {
    doc,
    engine,
    transport,
    keys,
    claim: (deputies: string[] = []) => connection.claimOwnership(ownership.genesis!, deputies),
    writes: async (text: string) => {
      engine.transact(() => write(doc, text))
      await engine.flush()
    },
    anchor: async (by: DeviceIdentity = notebook.owner) => {
      await transport.depositSnapshot(
        await createSnapshot({
          signingKey: by.signingKey,
          author: by.did,
          domain: keyDomainFor(NOTEBOOK),
          resourceId: RESOURCE,
          kind: "automatic",
          epoch: keys.currentEpoch,
          dek: (await keys.keyFor(keys.currentEpoch))!,
          state: Y.encodeStateAsUpdate(doc),
          covers: engine.deliveryVector(),
        }),
      )
    },
  }
}

/** A device opening the note with nothing of it yet: new, or long away. */
async function aLateDevice(notebook: Notebook, device: DeviceIdentity) {
  const transport = connect(notebook, device).transportFor(RESOURCE)
  const keys = await keysOf(notebook, device)
  const doc = new Y.Doc()
  doc.clientID = device.clientId
  doc.getXmlFragment("default")
  const engine = createNoteSyncEngine({
    doc,
    notebookId: NOTEBOOK,
    noteId: "kyoto",
    index: notebook.directory,
    owner: notebook.owner.did,
    author: device.did,
    signingKey: device.signingKey,
    clientId: device.clientId,
    keys: liveKeys(() => keys),
    transport,
  })
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId: RESOURCE,
    readableEpochs: () => keys.readableEpochs(),
    relay: { state: () => "online", onChange: () => () => undefined },
    anchorAuthors: () => [notebook.owner.did],
    canAuthor: false,
  })
  await session.settled()
  return { doc, close: () => session.close() }
}

/** A month and a bit, with the owner's claim and anchor in place. */
async function aPrunedNote(notebook: Notebook) {
  const sindre = await theOwner(notebook)
  expect(await sindre.claim()).toBe(true)
  await sindre.writes("Flights booked.")
  await sindre.anchor()
  notebook.clock.now += 31 * DAY
  await sindre.writes("Hotel near the station.")
  return sindre
}

describe("letting envelopes go behind the owner's anchor", () => {
  it("lets go of what the anchor covers once it is a month old", async () => {
    const notebook = await aNotebook()
    const sindre = await aPrunedNote(notebook)

    expect(notebook.server.sweep()).toBeGreaterThan(0)
    expect(await sindre.transport.floor!()).toEqual({ [notebook.owner.did]: 1 })
    expect(notebook.server.store.envelopeCount(RESOURCE)).toBe(1)
  })

  /** What makes letting go safe: nobody is left without the start of the note. */
  it("still gives the whole note to a device that never saw what was let go", async () => {
    const notebook = await aNotebook()
    await aPrunedNote(notebook)
    notebook.server.sweep()

    const ada = await aLateDevice(notebook, notebook.ada)
    expect(read(ada.doc)).toBe("Flights booked.Hotel near the station.")
    ada.close()
  })

  it("lets nothing go while it is younger than a month", async () => {
    const notebook = await aNotebook()
    const sindre = await theOwner(notebook)
    await sindre.claim()
    await sindre.writes("Flights booked.")
    await sindre.anchor()
    notebook.clock.now += 29 * DAY

    expect(notebook.server.sweep()).toBe(0)
  })

  /** Only the owner's anchors: a member's claim of what one covers is not trusted. */
  it("lets nothing go behind a member's anchor", async () => {
    const notebook = await aNotebook()
    const sindre = await theOwner(notebook)
    await sindre.claim()
    await sindre.writes("Flights booked.")
    await sindre.anchor(notebook.ada)
    notebook.clock.now += 31 * DAY

    expect(notebook.server.sweep()).toBe(0)
  })

  it("lets nothing go for a notebook whose owner never said so", async () => {
    const notebook = await aNotebook()
    const sindre = await theOwner(notebook)
    await sindre.writes("Flights booked.")
    await sindre.anchor()
    notebook.clock.now += 31 * DAY

    expect(notebook.server.sweep()).toBe(0)
  })

  /** A rival claim cannot win; it can only stop letting go altogether. */
  it("lets nothing go once someone else has claimed the notebook too", async () => {
    const notebook = await aNotebook()
    const sindre = await theOwner(notebook)
    await sindre.claim()
    const { createGenesis } = await import("./genesis")
    const rival = await createGenesis({
      signingKey: notebook.ada.signingKey,
      owner: notebook.ada.did,
      workspace: `workspace:${NOTEBOOK}`,
      resource: `notebook:${NOTEBOOK}`,
    })
    expect(await connect(notebook, notebook.ada).claimOwnership(rival)).toBe(true)
    await sindre.writes("Flights booked.")
    await sindre.anchor()
    notebook.clock.now += 31 * DAY

    expect(notebook.server.sweep()).toBe(0)
  })

  /** Partway would leave the floor where no anchor is, and nothing to rebuild from. */
  it("lets nothing go behind an anchor until all it covers is old", async () => {
    const notebook = await aNotebook()
    const sindre = await theOwner(notebook)
    await sindre.claim()
    await sindre.writes("Flights booked.")
    notebook.clock.now += 20 * DAY
    await sindre.writes("Hotel near the station.")
    await sindre.anchor()
    notebook.clock.now += 11 * DAY

    expect(notebook.server.sweep()).toBe(0)
    notebook.clock.now += 20 * DAY
    expect(notebook.server.sweep()).toBe(2)
  })

  /** The anchor holds what was let go, so the archive's quota must not shed it. */
  it("keeps the anchor the floor relies on, however many points follow", async () => {
    const notebook = await aNotebook({ ...DEFAULT_QUOTA, maxSnapshotsPerResource: 2 })
    const sindre = await aPrunedNote(notebook)
    notebook.server.sweep()
    for (const text of [" One.", " Two.", " Three."]) {
      await sindre.writes(text)
      await sindre.anchor(notebook.ada)
    }

    const ada = await aLateDevice(notebook, notebook.ada)
    expect(read(ada.doc)).toContain("Flights booked.")
    ada.close()
  })

  /** The owner's phone acts as the owner, so its anchors count - for as long as the owner says so. */
  it("lets go behind an anchor from a device the owner names, until it stops naming it", async () => {
    const notebook = await aNotebook()
    const phone = await aDevice()
    const sindre = await theOwner(notebook)
    await sindre.claim([phone.did])
    await sindre.writes("Flights booked.")
    await sindre.anchor(phone)
    notebook.clock.now += 31 * DAY
    expect(notebook.server.sweep()).toBe(1)

    await sindre.claim([])
    await sindre.writes("Hotel near the station.")
    await sindre.anchor(phone)
    notebook.clock.now += 31 * DAY
    expect(notebook.server.sweep()).toBe(0)
  })

  it("refuses a claim made for someone else", async () => {
    const notebook = await aNotebook()
    const ownership = await resolveOwnership(genesisClaims(notebook.directory))
    expect(await connect(notebook, notebook.ada).claimOwnership(ownership.genesis!)).toBe(false)
  })
})

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

describe("history once envelopes are let go", () => {
  afterEach(() => vi.restoreAllMocks())

  /** Restoring rebuilds from the anchor, so nothing before the floor goes missing. */
  it("restores to a point after the floor with everything before it", async () => {
    const notebook = await aNotebook()
    // Envelopes are dated by their author, so the writing follows the same clock.
    vi.spyOn(Date, "now").mockImplementation(() => notebook.clock.now)
    const sindre = await aPrunedNote(notebook)
    notebook.server.sweep()
    notebook.clock.now += DAY
    await sindre.writes("Dinner reservations nobody wanted.")

    const history = new NoteHistory({
      notebookId: NOTEBOOK,
      noteId: "kyoto",
      doc: sindre.doc,
      storage: aStore(),
      device: notebook.owner,
      keys: () => sindre.keys,
      transport: () => sindre.transport,
    })
    const sessions = await history.sessions()
    const hotel = sessions.find((session) => session.end[notebook.owner.did] === 2)!
    await history.restore(hotel.id)

    expect(read(sindre.doc)).toBe("Flights booked.Hotel near the station.")
  })
})
