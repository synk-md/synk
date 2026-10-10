/**
 * Two members editing one note, encrypted, through a running relay.
 *
 * The check the test suite cannot make. Everything in vitest shares one process
 * and often one `Y.Doc`; this founds a real notebook, admits a second member
 * through the real invitation flow, and then has two sync engines exchange
 * edits over a socket - verifying signatures, walking capability chains and
 * opening epoch keys at every step.
 *
 * Run `pnpm relay` first. Exits non-zero when the round trip does not complete.
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
import { RelayConnection, SocketLink } from "../src/lib/relay/index.ts"
import { collectJoinSnapshot, verifySnapshot } from "../src/lib/snapshots/index.ts"
import {
  admitFromRedemption,
  createNoteSyncEngine,
  noteRefsFor,
  runNoteAdmission,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  readNotebookKeys,
  redeemIntoNotebook,
} from "../src/lib/workspace/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"
const NOTEBOOK = `smoke-${String(Date.now())}`
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

async function connect(device: DeviceIdentity): Promise<RelayConnection> {
  const socket = new WebSocket(URL)
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve())
    socket.on("error", reject)
  })
  return new RelayConnection({
    link: new SocketLink(socket),
    relayId: RELAY_ID,
    did: device.did,
    signingKey: device.signingKey,
    timeoutMs: 5000,
    onError: (error) => console.error("relay error", error),
  })
}

// The notebook's index document. Shared directly here; in the app it syncs.
const index = new Y.Doc()

const owner = await aDevice()
await foundNotebookWorkspace({ doc: index, notebookId: NOTEBOOK, device: owner, label: "Owner" })
await foundNotebookKeys({ doc: index, notebookId: NOTEBOOK, device: owner })
console.log("notebook founded, owner admitted")

const joiner = await aDevice()
const { secret } = generateInvitationSecret()
const invitation = await inviteToNotebook({
  doc: index,
  notebookId: NOTEBOOK,
  admin: owner,
  secret,
  label: "Ada",
})
const redemption = await redeemIntoNotebook({ doc: index, secret, device: joiner })
const granted = await admitFromRedemption({
  doc: index,
  notebookId: NOTEBOOK,
  owner,
  invitation,
  redemption,
  ability: "write",
})
console.log(`joiner admitted at epoch ${String(granted.epoch)}`)

async function keyringFor(device: DeviceIdentity) {
  const keys = await readNotebookKeys({
    doc: index,
    notebookId: NOTEBOOK,
    device,
    owner: owner.did,
  })
  if (!keys.keyring) throw new Error(`no keyring for ${device.did}: ${keys.access}`)
  return keys.keyring
}

const ownerConnection = await connect(owner)
const joinerConnection = await connect(joiner)

// Content that predates the joiner, authored directly rather than through an
// engine - so it exists in the document and not in the relay, which is what
// makes a baseline necessary. Written into ownerDoc itself: applying an update
// authored under a document's own client id makes Yjs reassign it.
const ownerDoc = new Y.Doc()
ownerDoc.clientID = owner.clientId
ownerDoc.getText("body").insert(0, "written before anyone joined. ")

const ownerKeyring = await keyringFor(owner)
const covered = await runNoteAdmission({
  notebookId: NOTEBOOK,
  joiner: joiner.did,
  epochs: { [`notebook:${NOTEBOOK}`]: granted.epoch },
  notes: noteRefsFor(NOTEBOOK, [NOTE]),
  loadNote: () => Promise.resolve(ownerDoc),
  keyFor: (_domain, epoch) => ownerKeyring.keyFor(epoch),
  signingKey: owner.signingKey,
  author: owner.did,
  deposit: (snapshot) =>
    ownerConnection.transportFor(`notebook:${NOTEBOOK}/note:${NOTE}`).depositSnapshot(snapshot),
})
console.log(`notes covered: built=${JSON.stringify(covered.built)} skipped=${JSON.stringify(covered.skipped)}`)

const joinerDoc = new Y.Doc()
joinerDoc.clientID = joiner.clientId

const resource = `notebook:${NOTEBOOK}/note:${NOTE}`
const common = { notebookId: NOTEBOOK, noteId: NOTE, index, owner: owner.did }

const ownerEngine = createNoteSyncEngine({
  ...common,
  doc: ownerDoc,
  author: owner.did,
  signingKey: owner.signingKey,
  clientId: owner.clientId,
  keys: await keyringFor(owner),
  transport: ownerConnection.transportFor(resource),
})
const joinerEngine = createNoteSyncEngine({
  ...common,
  doc: joinerDoc,
  author: joiner.did,
  signingKey: joiner.signingKey,
  clientId: joiner.clientId,
  keys: await keyringFor(joiner),
  transport: joinerConnection.transportFor(resource),
  onDenied: (did, reason) => console.error(`joiner denied ${did}: ${reason}`),
})

// Subscriptions must be live before anything is published.
await new Promise((resolve) => setTimeout(resolve, 300))

// The joiner collects its baseline, exactly as the app would on first open.
const joinerKeyring = await keyringFor(joiner)
const baseline = await collectJoinSnapshot({
  transport: joinerConnection.transportFor(resource),
  resourceId: resource,
  readableEpochs: joinerKeyring.readableEpochs(),
})
if (!baseline) throw new Error("joiner found no baseline it could open")
const applied = await joinerEngine.applySnapshot(baseline, (snapshot, author) =>
  verifySnapshot(snapshot, author.publicKey),
)
console.log(`joiner applied baseline: ${String(applied)}`)

ownerEngine.transact(() => {
  ownerDoc.getText("body").insert(0, "written by the owner. ")
})
await ownerEngine.flush()
await new Promise((resolve) => setTimeout(resolve, 400))
await joinerEngine.flush()

joinerEngine.transact(() => {
  joinerDoc.getText("body").insert(joinerDoc.getText("body").length, "and by the joiner.")
})
await joinerEngine.flush()
await new Promise((resolve) => setTimeout(resolve, 400))
await ownerEngine.flush()

const ownerText = ownerDoc.getText("body").toJSON()
const joinerText = joinerDoc.getText("body").toJSON()
console.log("owner sees: ", JSON.stringify(ownerText))
console.log("joiner sees:", JSON.stringify(joinerText))
console.log("owner applied:", ownerEngine.stats.applied, "rejected:", JSON.stringify(ownerEngine.stats.rejected).slice(0, 80))

const converged =
  ownerText === joinerText &&
  ownerText.includes("before anyone joined") &&
  ownerText.includes("owner") &&
  ownerText.includes("joiner")

ownerEngine.close()
joinerEngine.close()
ownerConnection.close()
joinerConnection.close()

console.log(converged ? "OK" : "FAILED")
process.exit(converged ? 0 : 1)
