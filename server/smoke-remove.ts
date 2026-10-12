/**
 * Removing a member, through a running relay.
 *
 * Every device keeps its own copy of the directory, synced through the relay,
 * so the removal reaches the others the way it would in the app: as a record
 * that has to arrive before anyone acts on it.
 *
 * Run `pnpm relay` first. Exits non-zero unless the removed member reads nothing
 * written afterwards while everyone else carries on.
 */

import * as Y from "yjs"
import { WebSocket } from "ws"

import { generateSealingKey, generateSigningKey } from "../src/lib/crypto/index.ts"
import { generateInvitationSecret } from "../src/lib/directory/index.ts"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "../src/lib/identity/index.ts"
import type { ReadKeySource } from "../src/lib/keys/index.ts"
import { RelayConnection, SocketLink, type RelayConnectionState } from "../src/lib/relay/index.ts"
import type { SyncEngine } from "../src/lib/sync/index.ts"
import {
  admitFromRedemption,
  createDirectoryReplica,
  createNoteSyncEngine,
  directoryChannel,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  liveKeys,
  noteResourceId,
  openSyncSession,
  readNotebookKeys,
  readNotebookWorkspace,
  redeemIntoNotebook,
  removeFromNotebook,
  type RelayWatch,
} from "../src/lib/workspace/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"
const NOTEBOOK = `remove-${String(Date.now())}`
const NOTE = "kyoto"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const channel = await directoryChannel(NOTEBOOK)

interface Device {
  identity: DeviceIdentity
  directory: Y.Doc
  note: Y.Doc
  engine: SyncEngine | null
  /** Whether this device's keys open the current epoch. */
  current: boolean
  close(): void
}

/** A device in the app: its own directory, synced, and a note open once it holds keys. */
async function bringUp(identity: DeviceIdentity, directory: Y.Doc, owner: string): Promise<Device> {
  const listeners = new Set<(state: RelayConnectionState) => void>()
  const socket = new WebSocket(URL)
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve())
    socket.on("error", reject)
  })
  const connection = new RelayConnection({
    link: new SocketLink(socket),
    relayId: RELAY_ID,
    did: identity.did,
    signingKey: identity.signingKey,
    timeoutMs: 5000,
    onConnectionChange: (state) => {
      for (const listener of listeners) listener(state)
    },
  })
  const relay: RelayWatch = {
    state: () => connection.state,
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const directoryTransport = connection.transportFor(channel.resourceId)
  const directoryEngine = createDirectoryReplica({ doc: directory, channel, device: identity, transport: directoryTransport })
  const directorySession = openSyncSession({
    engine: directoryEngine,
    doc: directory,
    transport: directoryTransport,
    resourceId: channel.resourceId,
    readableEpochs: () => [],
    relay,
    canAuthor: true,
    recover: "publish-state",
  })

  const note = new Y.Doc()
  note.clientID = identity.clientId
  const device: Device = {
    identity,
    directory,
    note,
    engine: null,
    current: false,
    close: () => {
      device.engine?.close()
      directorySession.close()
      directoryEngine.close()
      connection.close()
      socket.close()
    },
  }

  // What the app's keys hook does: re-read on every directory change.
  let keyring: ReadKeySource | null = null
  const rekey = async () => {
    const keys = await readNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: identity, owner })
    device.current = keys.current
    if (!keys.keyring || !keys.current) return
    keyring = keys.keyring
    if (device.engine) return
    const resourceId = noteResourceId(NOTEBOOK, NOTE)
    const transport = connection.transportFor(resourceId)
    device.engine = createNoteSyncEngine({
      doc: note,
      notebookId: NOTEBOOK,
      noteId: NOTE,
      index: directory,
      owner,
      author: identity.did,
      signingKey: identity.signingKey,
      clientId: identity.clientId,
      keys: liveKeys(() => keyring!),
      transport,
    })
    openSyncSession({
      engine: device.engine,
      doc: note,
      transport,
      resourceId,
      readableEpochs: () => keyring?.readableEpochs() ?? [],
      relay,
      canAuthor: true,
    })
  }
  directory.on("update", () => void rekey())
  await rekey()
  return device
}

const text = (device: Device) => device.note.getText("body").toJSON()
const write = (device: Device, value: string) =>
  device.engine!.transact(() => device.note.getText("body").insert(text(device).length, value))

// Founded on the owner's device, with Ada and Grace let in.
const ownerIdentity = await aDevice()
const ownerDirectory = new Y.Doc()
await foundNotebookWorkspace({ doc: ownerDirectory, notebookId: NOTEBOOK, device: ownerIdentity, label: "Owner" })
await foundNotebookKeys({ doc: ownerDirectory, notebookId: NOTEBOOK, device: ownerIdentity })
const adaIdentity = await aDevice()
const graceIdentity = await aDevice()
for (const [identity, label] of [[adaIdentity, "Ada"], [graceIdentity, "Grace"]] as const) {
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: ownerDirectory, notebookId: NOTEBOOK, admin: ownerIdentity, secret, label })
  const redemption = await redeemIntoNotebook({ doc: ownerDirectory, secret, device: identity })
  await admitFromRedemption({ doc: ownerDirectory, notebookId: NOTEBOOK, owner: ownerIdentity, invitation, redemption, ability: "write" })
}

const owner = await bringUp(ownerIdentity, ownerDirectory, ownerIdentity.did)
await pause(500)
const ada = await bringUp(adaIdentity, new Y.Doc(), ownerIdentity.did)
const grace = await bringUp(graceIdentity, new Y.Doc(), ownerIdentity.did)
await pause(1000)

write(owner, "before. ")
await pause(800)
console.log("ada before removal:  ", JSON.stringify(text(ada)))
console.log("grace before removal:", JSON.stringify(text(grace)))

const workspace = await readNotebookWorkspace({ doc: ownerDirectory, notebookId: NOTEBOOK, selfDid: ownerIdentity.did })
const adaMember = workspace.directory?.devices.find((device) => device.record.did === adaIdentity.did)
if (adaMember?.kind !== "admitted") throw new Error("ada is not an admitted member")
const removed = await removeFromNotebook({
  doc: ownerDirectory,
  notebookId: NOTEBOOK,
  owner: ownerIdentity,
  member: adaMember.admission.member,
  reason: "smoke test",
})
console.log(`removed ada; new epoch ${String(removed.epoch)}`)
await pause(1500)

write(owner, "after. ")
await pause(800)
write(grace, "and Grace.")
await pause(1200)

console.log("ada can open the current epoch:", ada.current)
console.log("ada sees:  ", JSON.stringify(text(ada)))
console.log("grace sees:", JSON.stringify(text(grace)))
console.log("owner sees:", JSON.stringify(text(owner)))

const ok =
  text(ada) === "before. " &&
  !ada.current &&
  text(grace) === "before. after. and Grace." &&
  text(owner) === "before. after. and Grace."

for (const device of [owner, ada, grace]) device.close()
console.log(ok ? "OK" : "FAILED")
process.exit(ok ? 0 : 1)
