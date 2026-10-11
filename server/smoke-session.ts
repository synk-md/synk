/**
 * The app's note path end to end, through a running relay: sessions rather
 * than bare engines, and a reload in the middle.
 *
 * A reload is the case the test suite modelled and could not prove. Every
 * earlier slice passed its suite and failed at the seam where a real socket
 * replaced a fake, and this one replaces the most.
 *
 * Run `pnpm relay` first. Exits non-zero when anything does not arrive.
 */

import * as Y from "yjs"
import { WebSocket } from "ws"

import { generateSealingKey, generateSigningKey } from "../src/lib/crypto/index.ts"
import { generateInvitationSecret } from "../src/lib/directory/index.ts"
import {
  createDeviceRecord,
  didFromSigningKey,
  type DeviceIdentity,
} from "../src/lib/identity/index.ts"
import { RelayConnection, SocketLink, type RelayConnectionState } from "../src/lib/relay/index.ts"
import { memoryCursorStore, type SyncCursorStore } from "../src/lib/sync/index.ts"
import {
  admitFromRedemption,
  createNoteSyncEngine,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  noteResourceId,
  openNoteSession,
  readNotebookKeys,
  redeemIntoNotebook,
  type NoteSessionStatus,
} from "../src/lib/workspace/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"
const NOTEBOOK = `session-${String(Date.now())}`
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

const index = new Y.Doc()
const owner = await aDevice()
await foundNotebookWorkspace({ doc: index, notebookId: NOTEBOOK, device: owner, label: "Owner" })
await foundNotebookKeys({ doc: index, notebookId: NOTEBOOK, device: owner })

const member = await aDevice()
const { secret } = generateInvitationSecret()
const invitation = await inviteToNotebook({ doc: index, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
const redemption = await redeemIntoNotebook({ doc: index, secret, device: member })
await admitFromRedemption({ doc: index, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
console.log("notebook founded, member admitted")

interface Open {
  doc: Y.Doc
  statuses: NoteSessionStatus[]
  close(): void
}

/** What the editor does when a note opens: connection, engine, session. */
async function openNote(device: DeviceIdentity, doc: Y.Doc, cursor: SyncCursorStore): Promise<Open> {
  const listeners = new Set<(state: RelayConnectionState) => void>()
  const socket = new WebSocket(URL)
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve())
    socket.on("error", reject)
  })
  const connection = new RelayConnection({
    link: new SocketLink(socket),
    relayId: RELAY_ID,
    did: device.did,
    signingKey: device.signingKey,
    timeoutMs: 5000,
    onConnectionChange: (state) => {
      for (const listener of listeners) listener(state)
    },
    onError: (error) => console.error("relay error", error),
  })

  const keys = await readNotebookKeys({ doc: index, notebookId: NOTEBOOK, device, owner: owner.did })
  if (!keys.keyring) throw new Error(`no keyring for ${device.did}: ${keys.access}`)
  const keyring = keys.keyring

  const transport = connection.transportFor(RESOURCE)
  const engine = createNoteSyncEngine({
    doc,
    notebookId: NOTEBOOK,
    noteId: NOTE,
    index,
    owner: owner.did,
    author: device.did,
    signingKey: device.signingKey,
    clientId: device.clientId,
    keys: keyring,
    transport,
    cursor,
    onError: (error) => console.error("engine error", error),
  })
  const statuses: NoteSessionStatus[] = []
  const session = openNoteSession({
    engine,
    doc,
    transport,
    resourceId: RESOURCE,
    readableEpochs: () => keyring.readableEpochs(),
    relay: {
      state: () => connection.state,
      onChange: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    canAuthor: true,
    onStatus: (status) => statuses.push(status),
    onError: (error) => console.error("session error", error),
  })

  const deadline = Date.now() + 8000
  while (statuses.at(-1) !== "live") {
    if (Date.now() > deadline) throw new Error(`never went live: ${statuses.join(" > ")}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return {
    doc,
    statuses,
    close: () => {
      session.close()
      engine.close()
      connection.close()
      socket.close()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500))
const text = (doc: Y.Doc) => doc.getText("body").toJSON()

function pinned(device: DeviceIdentity): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = device.clientId
  return doc
}

// Written in the plaintext era: in the owner's IndexedDB, nowhere else.
const ownerDoc = pinned(owner)
ownerDoc.getText("body").insert(0, "from before the switch. ")
const ownerCursor = memoryCursorStore()

let ownerNote = await openNote(owner, ownerDoc, ownerCursor)
const memberNote = await openNote(member, pinned(member), memoryCursorStore())
await settle()
console.log("member after open:     ", JSON.stringify(text(memberNote.doc)))

ownerDoc.transact(() => ownerDoc.getText("body").insert(text(ownerDoc).length, "live. "))
await settle()
console.log("member after live edit:", JSON.stringify(text(memberNote.doc)))

// The reload: everything in memory goes, the document and cursor stay.
ownerNote.close()
ownerNote = await openNote(owner, ownerDoc, ownerCursor)
ownerDoc.transact(() => ownerDoc.getText("body").insert(text(ownerDoc).length, "after reload. "))
await settle()
console.log("member after reload:   ", JSON.stringify(text(memberNote.doc)))

memberNote.doc.transact(() =>
  memberNote.doc.getText("body").insert(text(memberNote.doc).length, "and Ada."),
)
await settle()

const ownerText = text(ownerDoc)
const memberText = text(memberNote.doc)
console.log("owner sees: ", JSON.stringify(ownerText))
console.log("member sees:", JSON.stringify(memberText))
console.log("owner cursor:", JSON.stringify(ownerCursor.load()))

const expected = "from before the switch. live. after reload. and Ada."
const ok = ownerText === expected && memberText === expected

ownerNote.close()
memberNote.close()
console.log(ok ? "OK" : "FAILED")
process.exit(ok ? 0 : 1)
