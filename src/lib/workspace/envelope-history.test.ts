import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, readDirectory } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { createSnapshot } from "@/lib/snapshots"
import { MemoryRelay, makeEnvelope, type Envelope, type SyncEngine } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { sessionsOf, stateAt } from "./envelope-history"
import { foundNotebookKeys, keyDomainFor, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"
import { removeFromNotebook } from "./removal"

const NOTEBOOK = "travel"
const RESOURCE = noteResourceId(NOTEBOOK, "kyoto")

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function aNotebook() {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const ada = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc: directory, secret, device: ada })
  await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
  return { directory, owner, ada, relay: new MemoryRelay() }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

async function keysOf(notebook: Notebook, device: DeviceIdentity): Promise<ReadKeySource> {
  const keys = await readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })
  if (!keys.keyring) throw new Error(`no keys for ${device.did}`)
  return keys.keyring
}

interface Writer {
  doc: Y.Doc
  engine: SyncEngine
}

async function writer(notebook: Notebook, device: DeviceIdentity): Promise<Writer> {
  let keyring = await keysOf(notebook, device)
  const doc = new Y.Doc()
  doc.clientID = device.clientId
  const engine = createNoteSyncEngine({
    doc,
    notebookId: NOTEBOOK,
    noteId: "kyoto",
    index: notebook.directory,
    owner: notebook.owner.did,
    author: device.did,
    signingKey: device.signingKey,
    clientId: device.clientId,
    keys: liveKeys(() => keyring),
    transport: notebook.relay.attach(device.did),
  })
  void (async () => {
    keyring = await keysOf(notebook, device)
  })()
  return { doc, engine }
}

async function write(from: Writer, text: string, ...others: Writer[]) {
  from.engine.transact(() => from.doc.getText("body").insert(from.doc.getText("body").length, text))
  for (let round = 0; round < 3; round += 1) {
    for (const each of [from, ...others]) await each.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText("body").toJSON()
}

describe("sessions", () => {
  /** Credited to whoever wrote them - not to whichever device took a snapshot. */
  it("follows who is writing, one session per turn", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    const ada = await writer(notebook, notebook.ada)
    await write(sindre, "A. ", ada)
    await write(ada, "B. ", sindre)
    await write(sindre, "C.", ada)

    const sessions = sessionsOf(notebook.relay.stored())
    expect(sessions.map((session) => session.author)).toEqual([notebook.owner.did, notebook.ada.did, notebook.owner.did])
  })

  it("splits one person's writing at a long pause", () => {
    const at = (seq: number, createdAt: number) =>
      ({ author: "did:key:zA", seq, createdAt, epoch: 1 }) as unknown as Envelope
    const sessions = sessionsOf([at(1, 0), at(2, 60_000), at(3, 60_000 + 6 * 60_000)])
    expect(sessions.map((session) => session.changes)).toEqual([2, 1])
    expect(sessions[0].end).toEqual({ "did:key:zA": 2 })
  })

  /** Someone whose writing was all let go still counts in where a session ends. */
  it("ends every session past what the relay let go", () => {
    const at = (seq: number, createdAt: number) =>
      ({ author: "did:key:zA", seq, createdAt, epoch: 1 }) as unknown as Envelope
    const [session] = sessionsOf([at(4, 0)], { floor: { "did:key:zA": 3, "did:key:zB": 9 } })
    expect(session.end).toEqual({ "did:key:zA": 4, "did:key:zB": 9 })
  })

  it("leaves out envelopes from before they carried a time", () => {
    const legacy = { author: "did:key:zA", seq: 1, epoch: 1 } as unknown as Envelope
    expect(sessionsOf([legacy])).toEqual([])
  })
})

describe("rebuilding a point", () => {
  it("gives the note exactly as it stood when a session ended", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    const ada = await writer(notebook, notebook.ada)
    await write(sindre, "A. ", ada)
    await write(ada, "B. ", sindre)
    await write(sindre, "C.", ada)

    const [, adaSession] = sessionsOf(notebook.relay.stored())
    const rebuilt = await stateAt({
      cut: adaSession.end,
      anchors: [],
      envelopes: notebook.relay.stored(),
      keys: await keysOf(notebook, notebook.owner),
    })
    expect(textOf(rebuilt.state)).toBe("A. B. ")
    expect(rebuilt.complete).toBe(true)
  })

  /** Anchors keep the replay short: only what came after one is applied. */
  it("starts from the newest anchor before the point", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    await write(sindre, "Before the anchor. ")
    const keys = await keysOf(notebook, notebook.owner)
    const anchor = await createSnapshot({
      signingKey: notebook.owner.signingKey,
      author: notebook.owner.did,
      domain: keyDomainFor(NOTEBOOK),
      resourceId: RESOURCE,
      kind: "automatic",
      epoch: keys.currentEpoch,
      dek: (await keys.keyFor(keys.currentEpoch))!,
      state: Y.encodeStateAsUpdate(sindre.doc),
      covers: sindre.engine.deliveryVector(),
    })
    await write(sindre, "After it.")

    const everything = notebook.relay.stored()
    const [session] = sessionsOf(everything).slice(-1)
    // Only envelopes after the anchor: the one before it is not handed over at all.
    const afterAnchor = everything.filter((envelope) => envelope.seq > (anchor.covers[envelope.author] ?? 0))
    const rebuilt = await stateAt({ cut: session.end, anchors: [anchor], envelopes: afterAnchor, keys })
    expect(textOf(rebuilt.state)).toBe("Before the anchor. After it.")
  })

  /** What they wrote was real. Removing them does not rewrite the past. */
  it("still shows what a since-removed member wrote", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    const ada = await writer(notebook, notebook.ada)
    await write(ada, "Written by Ada before she left.", sindre)
    const [session] = sessionsOf(notebook.relay.stored())

    const directory = await readDirectory(notebook.directory, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
    const adaEntry = directory.devices.find((device) => device.record.did === notebook.ada.did)
    if (adaEntry?.kind !== "admitted") throw new Error("ada is not admitted")
    await removeFromNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, owner: notebook.owner, member: adaEntry.admission.member })

    const rebuilt = await stateAt({
      cut: session.end,
      anchors: [],
      envelopes: notebook.relay.stored(),
      keys: await keysOf(notebook, notebook.owner),
    })
    expect(textOf(rebuilt.state)).toBe("Written by Ada before she left.")
  })

  /** An envelope that claims to be Ada's but carries someone else's operations is not history. */
  it("refuses an envelope whose operations are not its author's", async () => {
    const notebook = await aNotebook()
    const keys = await keysOf(notebook, notebook.owner)
    const forged = new Y.Doc()
    forged.clientID = notebook.owner.clientId
    forged.getText("body").insert(0, "Put in Sindre's name.")
    const envelope = await makeEnvelope({
      signingKey: notebook.ada.signingKey,
      author: notebook.ada.did,
      seq: 1,
      resourceId: RESOURCE,
      epoch: keys.currentEpoch,
      dek: (await keys.keyFor(keys.currentEpoch))!,
      update: Y.encodeStateAsUpdate(forged),
    })

    const rebuilt = await stateAt({ cut: { [notebook.ada.did]: 1 }, anchors: [], envelopes: [envelope], keys })
    expect(textOf(rebuilt.state)).toBe("")
    expect(rebuilt.complete).toBe(false)
  })

  /**
   * Without the anchor that holds it, Sindre's writing is simply not there -
   * and Ada's, written after it elsewhere in the note, would look whole alone.
   */
  it("says so when what was let go is in no anchor here", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    const ada = await writer(notebook, notebook.ada)
    await write(sindre, "Let go. ", ada)
    ada.engine.transact(() => ada.doc.getMap("meta").set("title", "Kept"))
    await ada.engine.flush()
    const floor = { [notebook.owner.did]: 1 }
    const rest = notebook.relay.stored().filter((envelope) => envelope.author === notebook.ada.did)
    const [session] = sessionsOf(rest, { floor })

    const rebuilt = await stateAt({
      cut: session.end,
      anchors: [],
      envelopes: rest,
      keys: await keysOf(notebook, notebook.owner),
      floor,
    })
    expect(rebuilt.complete).toBe(false)
  })

  it("says so when part of a point cannot be opened here", async () => {
    const notebook = await aNotebook()
    const sindre = await writer(notebook, notebook.owner)
    await write(sindre, "Sealed under a key the reader lacks.")
    const [session] = sessionsOf(notebook.relay.stored())
    const lacking: Pick<ReadKeySource, "keyFor" | "readableEpochs"> = {
      keyFor: () => Promise.resolve(undefined),
      readableEpochs: () => [],
    }

    const rebuilt = await stateAt({ cut: session.end, anchors: [], envelopes: notebook.relay.stored(), keys: lacking })
    expect(rebuilt.complete).toBe(false)
  })
})
