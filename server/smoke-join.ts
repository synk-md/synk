/**
 * Joining a notebook through a running relay, with the owner and the invitee
 * never connected at the same time.
 *
 * Each step happens on a fresh connection that is closed before the next one
 * opens, so nothing can be passed directly: the invitation, the redemption,
 * the grant and the tree all have to wait at the relay.
 *
 * Run `pnpm relay` first. Exits non-zero when the join does not complete.
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
import type { SyncEngine, Transport } from "../src/lib/sync/index.ts"
import {
  admitFromRedemption,
  createDirectoryReplica,
  createTreeReplica,
  directoryChannel,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  liveKeys,
  matchInvitation,
  openSyncSession,
  pendingRedemptions,
  readNotebookKeys,
  redeemIntoNotebook,
  treeResourceId,
  type SyncSessionStatus,
} from "../src/lib/workspace/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"
const NOTEBOOK = `join-${String(Date.now())}`

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

/** One visit: connect, catch up, do something, deliver it, disconnect. */
async function visit(
  device: DeviceIdentity,
  doc: Y.Doc,
  resourceId: string,
  make: (transport: Transport) => SyncEngine,
  act: () => Promise<void> = () => Promise.resolve(),
) {
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
  })
  const transport = connection.transportFor(resourceId)
  const engine = make(transport)
  const statuses: SyncSessionStatus[] = []
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId,
    readableEpochs: () => [],
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
    recover: "publish-state",
    onStatus: (status) => statuses.push(status),
  })
  const deadline = Date.now() + 8000
  while (statuses.at(-1) !== "live") {
    if (Date.now() > deadline) throw new Error(`never went live: ${statuses.join(" > ")}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await act()
  await engine.flush()
  await new Promise((resolve) => setTimeout(resolve, 200))
  session.close()
  engine.close()
  connection.close()
  socket.close()
}

const channel = await directoryChannel(NOTEBOOK)
const directory = (device: DeviceIdentity, doc: Y.Doc, act?: () => Promise<void>) =>
  visit(device, doc, channel.resourceId, (transport) => createDirectoryReplica({ doc, channel, device, transport }), act)

// The owner founds, invites, and leaves.
const owner = await aDevice()
const ownerDirectory = new Y.Doc()
await foundNotebookWorkspace({ doc: ownerDirectory, notebookId: NOTEBOOK, device: owner, label: "Owner" })
await foundNotebookKeys({ doc: ownerDirectory, notebookId: NOTEBOOK, device: owner })
const ownerTree = new Y.Doc()
ownerTree.getMap("nodes").set("note_1", { name: "Flights to Kyoto" })
const { secret } = generateInvitationSecret()
const invitation = await inviteToNotebook({
  doc: ownerDirectory,
  notebookId: NOTEBOOK,
  admin: owner,
  secret,
  label: "Ada",
})
await directory(owner, ownerDirectory)
console.log("owner invited, and left")

// Ada opens the link with nobody else connected.
const ada = await aDevice()
const adaDirectory = new Y.Doc()
await directory(ada, adaDirectory, async () => {
    if (!(await matchInvitation(adaDirectory, secret))) throw new Error("invitation never arrived")
    await redeemIntoNotebook({ doc: adaDirectory, secret, device: ada })
})
console.log("ada found the invitation, asked to join, and left")

// The owner comes back, lets her in, and publishes the tree under her epoch.
await directory(owner, ownerDirectory, async () => {
    const waiting = pendingRedemptions(ownerDirectory)
    if (waiting.length !== 1) throw new Error(`expected one request, found ${String(waiting.length)}`)
    await admitFromRedemption({
      doc: ownerDirectory,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption: waiting[0],
      ability: "write",
    })
})
const ownerKeys = await readNotebookKeys({ doc: ownerDirectory, notebookId: NOTEBOOK, device: owner, owner: owner.did })
await visit(owner, ownerTree, treeResourceId(NOTEBOOK), (transport) =>
  createTreeReplica({
    tree: ownerTree,
    directory: ownerDirectory,
    notebookId: NOTEBOOK,
    owner: owner.did,
    device: owner,
    keys: liveKeys(() => ownerKeys.keyring!),
    transport,
  }),
)
console.log("owner let her in, and left")

// Ada comes back to a notebook she can read.
await directory(ada, adaDirectory)
const adaKeys = await readNotebookKeys({ doc: adaDirectory, notebookId: NOTEBOOK, device: ada, owner: owner.did })
console.log("ada's access:", adaKeys.access)
const adaTree = new Y.Doc()
if (adaKeys.keyring) {
  await visit(ada, adaTree, treeResourceId(NOTEBOOK), (transport) =>
    createTreeReplica({
      tree: adaTree,
      directory: adaDirectory,
      notebookId: NOTEBOOK,
      owner: owner.did,
      device: ada,
      keys: liveKeys(() => adaKeys.keyring!),
      transport,
    }),
  )
}
const titles = [...adaTree.getMap<{ name: string }>("nodes").values()].map((node) => node.name)
console.log("ada sees:", JSON.stringify(titles))

const ok = adaKeys.access === "reader" && titles.includes("Flights to Kyoto")
console.log(ok ? "OK" : "FAILED")
process.exit(ok ? 0 : 1)
