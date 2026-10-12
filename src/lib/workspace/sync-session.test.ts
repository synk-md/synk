import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateInvitationSecret } from "@/lib/directory"
import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { MemoryRelay, memoryCursorStore, type DeliveryVector, type SyncCursorStore } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace } from "./notebook-workspace"
import {
  openSyncSession,
  type DeliveryWatermark,
  type SyncSessionStatus,
  type RelayReachability,
} from "./sync-session"
import { snapshotNotesForJoiner } from "./note-snapshots"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"
const NOTE = "kyoto"
const RESOURCE = noteResourceId(NOTEBOOK, NOTE)

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return {
    did: didFromSigningKey(signingKey.publicKey),
    clientId: record.clientId,
    signingKey,
    sealingKey,
    record,
  }
}

async function keyringFor(index: Y.Doc, device: DeviceIdentity, owner: string) {
  const keys = await readNotebookKeys({ doc: index, notebookId: NOTEBOOK, device, owner, now: T0 + 10_000 })
  if (!keys.keyring) throw new Error(`no keyring for ${device.did}: ${keys.access}`)
  return keys.keyring
}

/** A notebook with an owner and one admitted member, and a relay between them. */
async function aSharedNotebook() {
  const index = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: index, notebookId: NOTEBOOK, device: owner, label: "Sindre", createdAt: T0 })
  await foundNotebookKeys({ doc: index, notebookId: NOTEBOOK, device: owner, createdAt: T0 })

  const member = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({
    doc: index,
    notebookId: NOTEBOOK,
    admin: owner,
    secret,
    label: "Ada",
    now: T0 + 1000,
  })
  const redemption = await redeemIntoNotebook({ doc: index, secret, device: member, now: T0 + 2000 })
  const granted = await admitFromRedemption({
    doc: index,
    notebookId: NOTEBOOK,
    owner,
    invitation,
    redemption,
    ability: "write",
    now: T0 + 3000,
  })
  return { index, owner, member, epoch: granted.epoch, relay: new MemoryRelay() }
}

type Shared = Awaited<ReturnType<typeof aSharedNotebook>>

function aRelayWatch(initial: RelayReachability = "online") {
  let state = initial
  const listeners = new Set<(next: RelayReachability) => void>()
  return {
    state: () => state,
    onChange: (listener: (next: RelayReachability) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: RelayReachability) {
      state = next
      for (const listener of listeners) listener(next)
    },
  }
}

function aMemo() {
  let id: string | null = null
  return { applied: () => id, record: (next: string) => (id = next) }
}

/** A device's document, pinned to its derived client id the way the editor does. */
function docFor(device: DeviceIdentity): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = device.clientId
  return doc
}

async function open(
  shared: Shared,
  device: DeviceIdentity,
  doc: Y.Doc,
  options: {
    relay?: ReturnType<typeof aRelayWatch>
    cursor?: SyncCursorStore
    canAuthor?: boolean
    baseline?: ReturnType<typeof aMemo>
    watermark?: DeliveryWatermark
  } = {},
) {
  const keys = await keyringFor(shared.index, device, shared.owner.did)
  const transport = shared.relay.attach(device.did)
  const engine = createNoteSyncEngine({
    doc,
    notebookId: NOTEBOOK,
    noteId: NOTE,
    index: shared.index,
    owner: shared.owner.did,
    author: device.did,
    signingKey: device.signingKey,
    clientId: device.clientId,
    keys,
    transport,
    cursor: options.cursor ?? memoryCursorStore(),
    now: () => T0 + 10_000,
  })
  const statuses: SyncSessionStatus[] = []
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId: RESOURCE,
    readableEpochs: () => keys.readableEpochs(),
    relay: options.relay ?? aRelayWatch(),
    baseline: options.baseline ?? aMemo(),
    canAuthor: options.canAuthor ?? true,
    onStatus: (status) => statuses.push(status),
    ...(options.watermark ? { watermark: options.watermark } : {}),
  })
  await session.settled()
  await engine.flush()
  return { engine, session, transport, statuses }
}

const text = (doc: Y.Doc) => doc.getText("body").toJSON()

describe("opening a note", () => {
  /** The member's view of a notebook that had content before they joined. */
  it("collects a baseline the member can read", async () => {
    const shared = await aSharedNotebook()
    const ownerDoc = docFor(shared.owner)
    ownerDoc.getText("body").insert(0, "written before Ada joined.")

    // What admitting her deposits, without the owner ever opening the note.
    const ownerKeys = await keyringFor(shared.index, shared.owner, shared.owner.did)
    const { snapshots } = await snapshotNotesForJoiner({
      notebookId: NOTEBOOK,
      notes: [{ noteId: NOTE, covers: {}, doc: ownerDoc }],
      epoch: shared.epoch,
      dek: (await ownerKeys.keyFor(shared.epoch))!,
      signingKey: shared.owner.signingKey,
      author: shared.owner.did,
      createdAt: T0 + 4000,
    })
    for (const snapshot of snapshots) shared.relay.archive(snapshot)

    const memberDoc = docFor(shared.member)
    const { statuses } = await open(shared, shared.member, memberDoc)

    expect(text(memberDoc)).toBe("written before Ada joined.")
    expect(statuses.at(-1)).toBe("live")
  })

  /**
   * Content from the plaintext era is not in the relay at all. The owner
   * opening the note is enough to put it there, under a key the member holds.
   */
  it("delivers the owner's earlier writing once the owner opens the note", async () => {
    const shared = await aSharedNotebook()
    const ownerDoc = docFor(shared.owner)
    ownerDoc.getText("body").insert(0, "from before the switch.")

    await open(shared, shared.owner, ownerDoc)
    const memberDoc = docFor(shared.member)
    await open(shared, shared.member, memberDoc)

    expect(text(memberDoc)).toBe("from before the switch.")
    expect(JSON.stringify(shared.relay.stored())).not.toContain("before the switch")
  })

  it("applies a baseline once, not on every open", async () => {
    const shared = await aSharedNotebook()
    const ownerDoc = docFor(shared.owner)
    ownerDoc.getText("body").insert(0, "x")
    const ownerKeys = await keyringFor(shared.index, shared.owner, shared.owner.did)
    const { snapshots } = await snapshotNotesForJoiner({
      notebookId: NOTEBOOK,
      notes: [{ noteId: NOTE, covers: {}, doc: ownerDoc }],
      epoch: shared.epoch,
      dek: (await ownerKeys.keyFor(shared.epoch))!,
      signingKey: shared.owner.signingKey,
      author: shared.owner.did,
      createdAt: T0 + 4000,
    })
    for (const snapshot of snapshots) shared.relay.archive(snapshot)

    const memo = aMemo()
    const memberDoc = docFor(shared.member)
    const first = await open(shared, shared.member, memberDoc, { baseline: memo })
    first.session.close()
    first.engine.close()
    const second = await open(shared, shared.member, memberDoc, { baseline: memo })

    expect(first.engine.stats.snapshotsApplied).toBe(1)
    expect(second.engine.stats.snapshotsApplied).toBe(0)
  })
})

describe("the relay going away and coming back", () => {
  it("says offline, then catches up and delivers what was written meanwhile", async () => {
    const shared = await aSharedNotebook()
    const relay = aRelayWatch()
    const ownerDoc = docFor(shared.owner)
    const owner = await open(shared, shared.owner, ownerDoc, { relay })
    const memberDoc = docFor(shared.member)
    const member = await open(shared, shared.member, memberDoc)

    relay.set("offline")
    owner.transport.connected = false
    owner.engine.transact(() => ownerDoc.getText("body").insert(0, "written offline."))
    await owner.engine.flush()
    expect(owner.statuses.at(-1)).toBe("offline")
    expect(text(memberDoc)).toBe("")

    owner.transport.connected = true
    relay.set("online")
    await owner.session.settled()
    await member.engine.sync()

    expect(owner.statuses.at(-1)).toBe("live")
    expect(text(memberDoc)).toBe("written offline.")
  })

  it("does nothing while the relay is unreachable at open", async () => {
    const shared = await aSharedNotebook()
    const { statuses, engine } = await open(shared, shared.owner, docFor(shared.owner), {
      relay: aRelayWatch("connecting"),
    })
    expect(statuses).toEqual(["connecting"])
    expect(engine.stats.published).toBe(0)
  })
})

describe("a second tab", () => {
  /** It shares the writing tab's cursor, so resuming here would reuse numbers. */
  it("never publishes from a tab that is not the writer", async () => {
    const shared = await aSharedNotebook()
    const ownerDoc = docFor(shared.owner)
    ownerDoc.getText("body").insert(0, "not yet published.")

    await open(shared, shared.owner, ownerDoc, { canAuthor: false })

    expect(shared.relay.size).toBe(0)
  })
})

/** Stands in for the note's own IndexedDB: survives the tab, durable on flush. */
function aWatermark(options: { flushes?: boolean } = {}) {
  let stored: DeliveryVector | null = null
  const watermark: DeliveryWatermark & { saves: number } = {
    saves: 0,
    load: () => Promise.resolve(stored),
    durable: () => (options.flushes === false ? new Promise<void>(() => undefined) : Promise.resolve()),
    save: (vector) => {
      stored = vector
      watermark.saves += 1
      return Promise.resolve()
    },
  }
  return watermark
}

describe("reopening a note", () => {
  async function aBusyNote(edits: number) {
    const shared = await aSharedNotebook()
    const ownerDoc = docFor(shared.owner)
    const owner = await open(shared, shared.owner, ownerDoc)
    for (let index = 0; index < edits; index += 1) {
      owner.engine.transact(() => ownerDoc.getText("body").insert(text(ownerDoc).length, "."))
    }
    await owner.engine.flush()
    return { shared, owner, ownerDoc }
  }

  /** The whole history was verified, authorised and decrypted again on every open. */
  it("fetches only what arrived since it was last open", async () => {
    const { shared, owner, ownerDoc } = await aBusyNote(40)
    const watermark = aWatermark()
    const memberDoc = docFor(shared.member)

    const first = await open(shared, shared.member, memberDoc, { watermark })
    expect(first.engine.stats.applied).toBe(40)
    first.session.close()
    first.engine.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    owner.engine.transact(() => ownerDoc.getText("body").insert(text(ownerDoc).length, "!"))
    await owner.engine.flush()

    const second = await open(shared, shared.member, memberDoc, { watermark })
    expect(second.engine.stats.applied).toBe(1)
    expect(text(memberDoc)).toBe(`${".".repeat(40)}!`)
  })

  /** Claiming more than storage holds would skip those operations on this device for good. */
  it("never saves a watermark its storage has not caught up with", async () => {
    const { shared } = await aBusyNote(5)
    const watermark = aWatermark({ flushes: false })

    const first = await open(shared, shared.member, docFor(shared.member), { watermark })
    first.session.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(watermark.saves).toBe(0)
    const second = await open(shared, shared.member, docFor(shared.member), { watermark })
    expect(second.engine.stats.applied).toBe(5)
  })
})
