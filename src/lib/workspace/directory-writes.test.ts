import * as Y from "yjs"
import { afterEach, describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, readDirectory } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { laneOwner, MemoryRelay, type SyncEngine, type Transport } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, pendingRedemptions, redeemIntoNotebook } from "./admission"
import { joinChannel, requestToJoin, watchJoinRequests, type JoinChannelAccess } from "./join-requests"
import { foundNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, genesisClaims, workspaceIdFor } from "./notebook-workspace"
import { configureOwnerPins, memoryOwnerPins, pinOwner } from "./owner-pins"
import { removeFromNotebook } from "./removal"
import { createDirectoryReplica, directoryChannel, directoryWriters } from "./replicas"
import { openSyncSession } from "./sync-session"

const NOTEBOOK = "travel"
const online = { state: () => "online" as const, onChange: () => () => undefined }

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** One relay log per channel, as the real relay keeps them. */
function aRelay() {
  const logs = new Map<string, MemoryRelay>()
  const at = (resourceId: string) => {
    let relay = logs.get(resourceId)
    if (!relay) {
      relay = new MemoryRelay()
      logs.set(resourceId, relay)
    }
    return relay
  }
  return { access: (device: DeviceIdentity): JoinChannelAccess => ({ transportFor: (id) => at(id).attach(device.did), relay: online }) }
}

type Relay = ReturnType<typeof aRelay>

interface Copy {
  doc: Y.Doc
  engine: SyncEngine
  sync(): Promise<void>
}

/** A device's copy of the notebook's directory, synced through the relay with the members-only rule. */
async function directoryOn(relay: Relay, device: DeviceIdentity): Promise<Copy> {
  const doc = new Y.Doc()
  const channel = await directoryChannel(NOTEBOOK)
  const transport = relay.access(device).transportFor(channel.resourceId)
  const engine = createDirectoryReplica({ doc, channel, device, transport, policy: directoryWriters(doc, NOTEBOOK) })
  return {
    doc,
    engine,
    sync: async () => {
      await engine.flush()
      for (let round = 0; round < 4; round += 1) await engine.sync()
    },
  }
}

async function aNotebook() {
  configureOwnerPins(memoryOwnerPins())
  const relay = aRelay()
  const owner = await aDevice()
  pinOwner(NOTEBOOK, owner.did)
  const maren = await directoryOn(relay, owner)
  await foundNotebookWorkspace({ doc: maren.doc, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc: maren.doc, notebookId: NOTEBOOK, device: owner })
  await maren.sync()
  return { relay, owner, maren }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

async function admitAda(notebook: Notebook) {
  const ada = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: notebook.maren.doc, notebookId: NOTEBOOK, admin: notebook.owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc: notebook.maren.doc, secret, device: ada })
  const admitted = await admitFromRedemption({ doc: notebook.maren.doc, notebookId: NOTEBOOK, owner: notebook.owner, invitation, redemption, ability: "write" })
  await notebook.maren.sync()
  const copy = await directoryOn(notebook.relay, ada)
  await copy.sync()
  return { device: ada, member: admitted.member, copy }
}

/** Hands over everyone else's envelopes before the owner's. */
function ownerLast(relayed: Transport, owner: string): Transport {
  const rank = (envelope: { author: string }) => (laneOwner(envelope.author) === owner ? 1 : 0)
  return {
    name: relayed.name,
    publish: (envelope) => relayed.publish(envelope),
    subscribe: (handler) => relayed.subscribe(handler),
    vector: () => relayed.vector(),
    depositSnapshot: (snapshot) => relayed.depositSnapshot(snapshot),
    fetchSnapshots: (resourceId) => relayed.fetchSnapshots(resourceId),
    close: () => relayed.close(),
    fetchSince: async (vector) => [...(await relayed.fetchSince(vector))].sort((a, b) => rank(a) - rank(b)),
  }
}

/** A device that has the notebook's owner remembered but none of its directory yet. */
async function aNewDevice(notebook: Notebook) {
  const laptop = await aDevice()
  const fresh = new Y.Doc()
  const channel = await directoryChannel(NOTEBOOK)
  const transport = ownerLast(notebook.relay.access(laptop).transportFor(channel.resourceId), notebook.owner.did)
  const engine = createDirectoryReplica({ doc: fresh, channel, device: laptop, transport, policy: directoryWriters(fresh, NOTEBOOK) })
  const session = openSyncSession({
    engine,
    doc: fresh,
    transport,
    resourceId: channel.resourceId,
    readableEpochs: () => [],
    relay: online,
    canAuthor: false,
    recover: "publish-state",
  })
  await session.settled()
  session.close()
  return fresh
}

afterEach(() => configureOwnerPins(null))

describe("who may write to a notebook's directory", () => {
  it("takes the owner's writes and a member's", async () => {
    const notebook = await aNotebook()
    const ada = await admitAda(notebook)
    ada.copy.doc.getMap("notes").set("from-ada", "hello")
    await ada.copy.sync()
    await notebook.maren.sync()

    expect(notebook.maren.doc.getMap("notes").get("from-ada")).toBe("hello")
    expect(genesisClaims(ada.copy.doc)).toHaveLength(1)
  })

  /** Anyone holding the link can reach the channel. What they write goes nowhere. */
  it("refuses a stranger's write", async () => {
    const notebook = await aNotebook()
    const mallory = await aDevice()
    const theirs = await directoryOn(notebook.relay, mallory)
    await theirs.sync()
    await foundNotebookWorkspace({ doc: theirs.doc, notebookId: NOTEBOOK, device: mallory, label: "Mallory" })
    theirs.doc.getMap("workspace:genesis").delete(notebook.owner.did)
    await theirs.sync()
    await notebook.maren.sync()

    expect(genesisClaims(notebook.maren.doc).map((claim) => claim.owner)).toEqual([notebook.owner.did])
  })

  /** Before its directory arrives, a new device already knows whose writes to take. */
  it("judges even the first writes a new device is handed", async () => {
    const notebook = await aNotebook()
    const mallory = await aDevice()
    const theirs = await directoryOn(notebook.relay, mallory)
    await theirs.sync()
    theirs.doc.getMap("workspace:genesis").delete(notebook.owner.did)
    await theirs.sync()

    const fresh = await aNewDevice(notebook)
    expect(genesisClaims(fresh).map((claim) => claim.owner)).toEqual([notebook.owner.did])
  })

  it("refuses a member's write once they are removed", async () => {
    const notebook = await aNotebook()
    const ada = await admitAda(notebook)
    await removeFromNotebook({ doc: notebook.maren.doc, notebookId: NOTEBOOK, owner: notebook.owner, member: ada.member })
    await notebook.maren.sync()
    await ada.copy.sync()

    ada.copy.doc.getMap("directory:removals").clear()
    await ada.copy.sync()
    await notebook.maren.sync()
    const directory = await readDirectory(notebook.maren.doc, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
    expect(directory.removed.has(ada.device.did)).toBe(true)
  })

  /** A new device can be handed a member's writes before the owner's that admit them. */
  it("takes a member's write that arrived before their admission, on the next round", async () => {
    const notebook = await aNotebook()
    const ada = await admitAda(notebook)
    ada.copy.doc.getMap("notes").set("from-ada", "hello")
    await ada.copy.sync()

    // Everyone else's first, so the first pass meets Ada before her admission.
    const fresh = await aNewDevice(notebook)
    expect(fresh.getMap("notes").get("from-ada")).toBe("hello")
  })
})

describe("asking to join on the invitation's own channel", () => {
  it("reaches the owner's device, which brings it into the directory", async () => {
    const notebook = await aNotebook()
    const stop = watchJoinRequests({
      notebookId: NOTEBOOK,
      directory: notebook.maren.doc,
      device: notebook.owner,
      access: notebook.relay.access(notebook.owner),
    })
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({ doc: notebook.maren.doc, notebookId: NOTEBOOK, admin: notebook.owner, secret, label: "Ada" })
    const ada = await aDevice()

    await requestToJoin({ secret, invitation, device: ada, access: notebook.relay.access(ada) })
    await expect.poll(() => pendingRedemptions(notebook.maren.doc).map((redemption) => redemption.did)).toEqual([ada.did])
    stop()
  })

  /** Only a request that proves the code is brought across. */
  it("leaves behind a request that does not hold the code", async () => {
    const notebook = await aNotebook()
    const stop = watchJoinRequests({
      notebookId: NOTEBOOK,
      directory: notebook.maren.doc,
      device: notebook.owner,
      access: notebook.relay.access(notebook.owner),
    })
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({ doc: notebook.maren.doc, notebookId: NOTEBOOK, admin: notebook.owner, secret, label: "Ada" })
    // Made with a code of their own and filed under this invitation, so it names
    // the right invitation and cannot prove it holds its code.
    const { secret: wrong } = generateInvitationSecret()
    const guess = await aDevice()
    const scratch = new Y.Doc()
    const made = await redeemIntoNotebook({ doc: scratch, secret: wrong, device: guess })
    const forged = { ...made, invitationId: invitation.invitationId }
    const channel = await joinChannel(invitation.invitationId)
    const request = new Y.Doc()
    const engine = createDirectoryReplica({
      doc: request,
      channel,
      device: guess,
      transport: notebook.relay.access(guess).transportFor(channel.resourceId),
    })
    request.getMap<unknown[]>("directory:redemptions").set(invitation.invitationId, [forged])
    await engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pendingRedemptions(notebook.maren.doc)).toEqual([])
    stop()
  })

  it("is brought across by none but the owner's devices", async () => {
    const notebook = await aNotebook()
    const member = await admitAda(notebook)
    const stop = watchJoinRequests({
      notebookId: NOTEBOOK,
      directory: member.copy.doc,
      device: member.device,
      access: notebook.relay.access(member.device),
    })
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({ doc: notebook.maren.doc, notebookId: NOTEBOOK, admin: notebook.owner, secret, label: "Bob" })
    await notebook.maren.sync()
    await member.copy.sync()
    const bob = await aDevice()

    await requestToJoin({ secret, invitation, device: bob, access: notebook.relay.access(bob) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pendingRedemptions(member.copy.doc)).toEqual([])
    stop()
  })
})
