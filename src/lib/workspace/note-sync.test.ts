import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateInvitationSecret } from "@/lib/directory"
import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { MemoryRelay, OfflineTransport } from "@/lib/sync"
import { openSnapshot, unwrapSnapshotKey } from "@/lib/snapshots"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace } from "./notebook-workspace"
import { snapshotNotesForJoiner, snapshotsForNote } from "./note-snapshots"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"
const NOTE = "kyoto"

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

/** A founded notebook with the owner holding keys. */
async function aNotebook() {
  const index = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({
    doc: index,
    notebookId: NOTEBOOK,
    device: owner,
    label: "Maren",
    createdAt: T0,
  })
  await foundNotebookKeys({ doc: index, notebookId: NOTEBOOK, device: owner, createdAt: T0 })
  return { index, owner }
}

async function keyringFor(index: Y.Doc, device: DeviceIdentity, owner: string) {
  const keys = await readNotebookKeys({
    doc: index,
    notebookId: NOTEBOOK,
    device,
    owner,
    now: T0 + 10_000,
  })
  if (!keys.keyring) throw new Error(`no keyring for ${device.did}: ${keys.access}`)
  return keys.keyring
}

/** Invite, redeem and grant, returning the admitted device. */
async function admit(index: Y.Doc, owner: DeviceIdentity) {
  const joiner = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({
    doc: index,
    notebookId: NOTEBOOK,
    admin: owner,
    secret,
    label: "Ada",
    now: T0 + 1000,
  })
  const redemption = await redeemIntoNotebook({
    doc: index,
    secret,
    device: joiner,
    now: T0 + 2000,
  })
  const granted = await admitFromRedemption({
    doc: index,
    notebookId: NOTEBOOK,
    owner,
    invitation,
    redemption,
    ability: "write",
    now: T0 + 3000,
  })
  return { joiner, granted }
}

describe("syncing a note between two members", () => {
  it("carries an edit end to end, encrypted", async () => {
    const { index, owner } = await aNotebook()
    const { joiner } = await admit(index, owner)
    const relay = new MemoryRelay()

    const ownerDoc = new Y.Doc()
    ownerDoc.clientID = owner.clientId
    const joinerDoc = new Y.Doc()
    joinerDoc.clientID = joiner.clientId

    const common = { notebookId: NOTEBOOK, noteId: NOTE, index, owner: owner.did }
    const ownerEngine = createNoteSyncEngine({
      ...common,
      doc: ownerDoc,
      author: owner.did,
      signingKey: owner.signingKey,
      clientId: owner.clientId,
      keys: await keyringFor(index, owner, owner.did),
      transport: relay.attach("owner"),
      now: () => T0 + 10_000,
    })
    const joinerEngine = createNoteSyncEngine({
      ...common,
      doc: joinerDoc,
      author: joiner.did,
      signingKey: joiner.signingKey,
      clientId: joiner.clientId,
      keys: await keyringFor(index, joiner, owner.did),
      transport: relay.attach("joiner"),
      now: () => T0 + 10_000,
    })

    ownerEngine.transact(() => {
      ownerDoc.getText("body").insert(0, "written by the owner")
    })
    await ownerEngine.flush()
    await joinerEngine.flush()

    expect(joinerDoc.getText("body").toJSON()).toBe("written by the owner")

    // Nothing the relay holds is readable as text.
    const stored = relay.stored()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored[0])).not.toContain("written by the owner")

    ownerEngine.close()
    joinerEngine.close()
  }, 20_000)

  it("refuses an envelope from a device the directory does not know", async () => {
    const { index, owner } = await aNotebook()
    const relay = new MemoryRelay()
    const stranger = await aDevice()

    const ownerDoc = new Y.Doc()
    ownerDoc.clientID = owner.clientId
    const ownerEngine = createNoteSyncEngine({
      notebookId: NOTEBOOK,
      noteId: NOTE,
      index,
      owner: owner.did,
      doc: ownerDoc,
      author: owner.did,
      signingKey: owner.signingKey,
      clientId: owner.clientId,
      keys: await keyringFor(index, owner, owner.did),
      transport: relay.attach("owner"),
      now: () => T0 + 10_000,
    })

    // The stranger holds no admission, so they cannot even be resolved.
    const strangerDoc = new Y.Doc()
    strangerDoc.clientID = stranger.clientId
    const strangerEngine = createNoteSyncEngine({
      notebookId: NOTEBOOK,
      noteId: NOTE,
      index,
      owner: owner.did,
      doc: strangerDoc,
      author: stranger.did,
      signingKey: stranger.signingKey,
      clientId: stranger.clientId,
      keys: await keyringFor(index, owner, owner.did),
      transport: relay.attach("stranger"),
      now: () => T0 + 10_000,
    })

    strangerEngine.transact(() => {
      strangerDoc.getText("body").insert(0, "not welcome")
    })
    await strangerEngine.flush()
    await ownerEngine.flush()

    expect(ownerDoc.getText("body").toJSON()).toBe("")
    expect(ownerEngine.stats.rejected["unknown-author"]).toBe(1)

    ownerEngine.close()
    strangerEngine.close()
  }, 20_000)

  /**
   * The whole point of walking a capability chain rather than asking "is a
   * member": membership cannot express read-only, and this device is a fully
   * admitted member whose grant simply does not permit writing.
   */
  it("refuses a write from a member admitted read-only", async () => {
    const index = new Y.Doc()
    const owner = await aDevice()
    await foundNotebookWorkspace({
      doc: index,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })
    await foundNotebookKeys({ doc: index, notebookId: NOTEBOOK, device: owner, createdAt: T0 })

    const reader = await aDevice()
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc: index,
      notebookId: NOTEBOOK,
      admin: owner,
      secret,
      label: "Read Only",
      now: T0 + 1000,
    })
    const redemption = await redeemIntoNotebook({
      doc: index,
      secret,
      device: reader,
      now: T0 + 2000,
    })
    await admitFromRedemption({
      doc: index,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      ability: "read",
      now: T0 + 3000,
    })

    const relay = new MemoryRelay()
    const ownerDoc = new Y.Doc()
    ownerDoc.clientID = owner.clientId
    const readerDoc = new Y.Doc()
    readerDoc.clientID = reader.clientId

    const common = { notebookId: NOTEBOOK, noteId: NOTE, index, owner: owner.did }
    const ownerEngine = createNoteSyncEngine({
      ...common,
      doc: ownerDoc,
      author: owner.did,
      signingKey: owner.signingKey,
      clientId: owner.clientId,
      keys: await keyringFor(index, owner, owner.did),
      transport: relay.attach("owner"),
      now: () => T0 + 10_000,
    })
    const readerEngine = createNoteSyncEngine({
      ...common,
      doc: readerDoc,
      author: reader.did,
      signingKey: reader.signingKey,
      clientId: reader.clientId,
      keys: await keyringFor(index, reader, owner.did),
      transport: relay.attach("reader"),
      now: () => T0 + 10_000,
    })

    // They are a real member with real keys, and the write is still refused.
    readerEngine.transact(() => {
      readerDoc.getText("body").insert(0, "should not land")
    })
    await readerEngine.flush()
    await ownerEngine.flush()

    expect(ownerDoc.getText("body").toJSON()).toBe("")
    expect(ownerEngine.stats.rejected.unauthorized).toBe(1)

    // And reading still works: the owner's edit reaches them.
    ownerEngine.transact(() => {
      ownerDoc.getText("body").insert(0, "from the owner")
    })
    await ownerEngine.flush()
    await readerEngine.flush()
    expect(readerDoc.getText("body").toJSON()).toContain("from the owner")

    ownerEngine.close()
    readerEngine.close()
  }, 20_000)

  it("names the note beneath its notebook, so a notebook grant covers it", () => {
    expect(noteResourceId(NOTEBOOK, NOTE)).toBe("notebook:travel/note:kyoto")
  })

  it("refuses to write under an epoch this device cannot open", async () => {
    const { index, owner } = await aNotebook()
    const keys = await keyringFor(index, owner, owner.did)
    keys.forget([1])

    const doc = new Y.Doc()
    doc.clientID = owner.clientId
    const errors: unknown[] = []
    const engine = createNoteSyncEngine({
      notebookId: NOTEBOOK,
      noteId: NOTE,
      index,
      owner: owner.did,
      doc,
      author: owner.did,
      signingKey: owner.signingKey,
      clientId: owner.clientId,
      keys,
      transport: new OfflineTransport(),
      now: () => T0 + 10_000,
      onError: (error) => errors.push(error),
    })

    engine.transact(() => {
      doc.getText("body").insert(0, "no key for this")
    })
    await engine.flush()

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/no key held/)
    engine.close()
  }, 20_000)
})

describe("snapshots for a joiner", () => {
  /**
   * Without one the joiner decrypts new edits and can place none of them: a gap
   * in an existing author's clock blocks everything that author writes later.
   */
  it("gives the joiner a baseline for every note", async () => {
    const { index, owner } = await aNotebook()

    const kyoto = new Y.Doc()
    kyoto.clientID = owner.clientId
    kyoto.getText("body").insert(0, "notes on Kyoto")
    const osaka = new Y.Doc()
    osaka.clientID = owner.clientId
    osaka.getText("body").insert(0, "notes on Osaka")

    const { joiner, granted } = await admit(index, owner)
    const ownerKeys = await keyringFor(index, owner, owner.did)
    const dek = await ownerKeys.keyFor(granted.epoch)

    const { snapshots } = await snapshotNotesForJoiner({
      notebookId: NOTEBOOK,
      notes: [
        { noteId: "kyoto", doc: kyoto },
        { noteId: "osaka", doc: osaka },
      ],
      epoch: granted.epoch,
      dek: dek!,
      signingKey: owner.signingKey,
      author: owner.did,
      createdAt: T0 + 3000,
    })

    expect(snapshots).toHaveLength(2)
    expect(snapshotsForNote(snapshots, NOTEBOOK, "kyoto")).toHaveLength(1)

    // The joiner holds the joining epoch, so they can open them.
    const joinerKeys = await keyringFor(index, joiner, owner.did)
    const joinerDek = await joinerKeys.keyFor(granted.epoch)
    expect(joinerDek).toBeDefined()

    const restored = new Y.Doc()
    Y.applyUpdate(
      restored,
      await openSnapshot(snapshots[0], await unwrapSnapshotKey(snapshots[0].wraps[0], joinerDek!)),
    )
    expect(restored.getText("body").toJSON()).toBe("notes on Kyoto")
  }, 20_000)

  /**
   * The failure a snapshot prevents is a clock gap belonging to a pre-existing
   * author. A document nobody has written to has no authors and no gaps.
   */
  it("skips a note with no operations, and says which", async () => {
    const { index, owner } = await aNotebook()
    const { granted } = await admit(index, owner)
    const ownerKeys = await keyringFor(index, owner, owner.did)

    const written = new Y.Doc()
    written.clientID = owner.clientId
    written.getText("body").insert(0, "something")

    const { snapshots, skipped } = await snapshotNotesForJoiner({
      notebookId: NOTEBOOK,
      notes: [
        { noteId: "empty", doc: new Y.Doc() },
        { noteId: "written", doc: written },
      ],
      epoch: granted.epoch,
      dek: (await ownerKeys.keyFor(granted.epoch))!,
      signingKey: owner.signingKey,
      author: owner.did,
      createdAt: T0 + 3000,
    })

    expect(skipped).toEqual(["empty"])
    expect(snapshots).toHaveLength(1)
  }, 20_000)
})
