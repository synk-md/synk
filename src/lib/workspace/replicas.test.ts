import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateInvitationSecret } from "@/lib/directory"
import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { MemoryRelay, type SyncEngine } from "@/lib/sync"

import {
  admitFromRedemption,
  inviteToNotebook,
  matchInvitation,
  pendingRedemptions,
  redeemIntoNotebook,
} from "./admission"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import {
  createDirectoryReplica,
  createTreeReplica,
  directoryChannel,
  treeResourceId,
  type DirectoryChannel,
} from "./replicas"
import { openSyncSession, type RelayReachability, type UnsentFlag } from "./sync-session"

const NOTEBOOK = "travel"

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

const online = {
  state: (): RelayReachability => "online",
  onChange: () => () => undefined,
}

interface Opened {
  engine: SyncEngine
  /** Delivers what is queued, then goes away - a tab closing. */
  leave(): Promise<void>
  refresh(): Promise<void>
}

async function opened(
  engine: SyncEngine,
  doc: Y.Doc,
  transport: ReturnType<MemoryRelay["attach"]>,
  resourceId: string,
  unsent?: UnsentFlag,
): Promise<Opened> {
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId,
    readableEpochs: () => [],
    relay: online,
    canAuthor: true,
    recover: "publish-state",
    ...(unsent ? { unsent } : {}),
  })
  await session.settled()
  await engine.flush()
  return {
    engine,
    leave: async () => {
      await engine.flush()
      session.close()
      engine.close()
      transport.close()
    },
    refresh: async () => {
      session.refresh()
      await session.settled()
      await engine.flush()
    },
  }
}

function openDirectory(
  relay: MemoryRelay,
  channel: DirectoryChannel,
  doc: Y.Doc,
  device: DeviceIdentity,
  unsent?: UnsentFlag,
) {
  const transport = relay.attach(device.did)
  const engine = createDirectoryReplica({ doc, channel, device, transport })
  return opened(engine, doc, transport, channel.resourceId, unsent)
}

/** What the app keeps per document: set by any local edit, outliving the tab. */
function anUnsentFlag(doc: Y.Doc): UnsentFlag & { set: boolean } {
  const flag = {
    set: false,
    get: () => flag.set,
    clear: () => {
      flag.set = false
    },
  }
  doc.on("update", (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (transaction.local) flag.set = true
  })
  return flag
}

/** A notebook founded on the owner's device, its directory not yet anywhere else. */
async function aNotebook() {
  const owner = await aDevice()
  const directory = new Y.Doc()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  return { owner, directory }
}

describe("joining through the relay", () => {
  /**
   * The point of moving the directory: the invitation, the redemption and the
   * grant each wait at the relay, so nobody has to be online at the same time
   * as anybody else.
   */
  it("lets someone join while the owner is away, and lets them in while they are away", async () => {
    const relay = new MemoryRelay()
    const channel = await directoryChannel(NOTEBOOK)
    const { owner, directory: ownerDirectory } = await aNotebook()

    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc: ownerDirectory,
      notebookId: NOTEBOOK,
      admin: owner,
      secret,
      label: "Ada",
    })
    await (await openDirectory(relay, channel, ownerDirectory, owner)).leave()

    // Ada opens the link with the owner gone.
    const ada = await aDevice()
    const adaDirectory = new Y.Doc()
    let adaSide = await openDirectory(relay, channel, adaDirectory, ada)
    expect(await matchInvitation(adaDirectory, secret)).not.toBeNull()
    await redeemIntoNotebook({ doc: adaDirectory, secret, device: ada })
    await adaSide.leave()

    // The owner, later, with Ada gone.
    const ownerSide = await openDirectory(relay, channel, ownerDirectory, owner)
    const waiting = pendingRedemptions(ownerDirectory)
    expect(waiting).toHaveLength(1)
    await admitFromRedemption({
      doc: ownerDirectory,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption: waiting[0],
      ability: "write",
    })
    await ownerSide.leave()

    // Ada comes back, and is in.
    adaSide = await openDirectory(relay, channel, adaDirectory, ada)
    const keys = await readNotebookKeys({ doc: adaDirectory, notebookId: NOTEBOOK, device: ada, owner: owner.did })
    expect(keys.access).toBe("reader")
    await adaSide.leave()
  })

  it("keeps the directory from the relay", async () => {
    const relay = new MemoryRelay()
    const channel = await directoryChannel(NOTEBOOK)
    const { owner, directory } = await aNotebook()
    const { secret } = generateInvitationSecret()
    await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada Lovelace" })
    await (await openDirectory(relay, channel, directory, owner)).leave()

    const stored = JSON.stringify(relay.stored())
    expect(relay.size).toBeGreaterThan(0)
    expect(stored).not.toContain("Ada Lovelace")
    expect(stored).not.toContain("Maren")
    // Nor can the relay tell which notebook it is holding.
    expect(channel.resourceId).not.toContain(NOTEBOOK)
  })

  it("files different notebooks' directories apart", async () => {
    const a = await directoryChannel("one")
    const b = await directoryChannel("two")
    expect(a.resourceId).not.toBe(b.resourceId)
    expect(await a.keys.forEpoch(0)).not.toEqual(await b.keys.forEpoch(0))
  })
})

/** Owner and member sharing one verified directory, as each would after syncing it. */
async function aSharedNotebook(ability: "read" | "write" = "write") {
  const { owner, directory } = await aNotebook()
  const member = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc: directory, secret, device: member })
  await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability })
  return { owner, member, directory, relay: new MemoryRelay() }
}

type Shared = Awaited<ReturnType<typeof aSharedNotebook>>

async function keysOf(directory: Y.Doc, device: DeviceIdentity, owner: string) {
  const keys = await readNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device, owner })
  if (!keys.keyring) throw new Error(`no keys for ${device.did}: ${keys.access}`)
  return keys.keyring
}

async function openTree(shared: Shared, device: DeviceIdentity, tree: Y.Doc, directory = shared.directory) {
  const transport = shared.relay.attach(device.did)
  // Read through, as the app does, so a cut epoch reaches the running engine.
  let keyring = await keysOf(directory, device, shared.owner.did)
  const engine = createTreeReplica({
    tree,
    directory,
    notebookId: NOTEBOOK,
    owner: shared.owner.did,
    device,
    keys: liveKeys(() => keyring),
    transport,
  })
  const side = await opened(engine, tree, transport, treeResourceId(NOTEBOOK))
  return {
    ...side,
    /** What the app does when the directory changes: re-read, then republish. */
    rekey: async () => {
      keyring = await keysOf(directory, device, shared.owner.did)
      await side.refresh()
    },
  }
}

const titles = (tree: Y.Doc) =>
  [...tree.getMap<{ name: string }>("nodes").values()].map((node) => node.name).sort()

describe("the tree through the relay", () => {
  it("is sealed under the notebook's keys", async () => {
    const shared = await aSharedNotebook()
    const ownerTree = new Y.Doc()
    const ownerSide = await openTree(shared, shared.owner, ownerTree)
    ownerTree.getMap("nodes").set("note_1", { name: "Flights to Kyoto" })
    await ownerSide.leave()

    const memberTree = new Y.Doc()
    await openTree(shared, shared.member, memberTree)

    expect(titles(memberTree)).toEqual(["Flights to Kyoto"])
    expect(JSON.stringify(shared.relay.stored())).not.toContain("Kyoto")
  })

  /**
   * Written under an epoch the member was never given. The owner's session
   * republishes when the epoch moves on, which is the moment admission happens
   * and so the one time the owner is certainly online.
   */
  it("reaches a member admitted after it was written", async () => {
    const { owner, directory } = await aNotebook()
    const shared = { owner, directory, relay: new MemoryRelay() }
    const ownerTree = new Y.Doc()
    ownerTree.getMap("nodes").set("note_1", { name: "Written before Ada" })
    const ownerSide = await openTree({ ...shared, member: owner }, owner, ownerTree)

    const member = await aDevice()
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
    const redemption = await redeemIntoNotebook({ doc: directory, secret, device: member })
    await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
    await ownerSide.rekey()
    await ownerSide.leave()

    const memberTree = new Y.Doc()
    await openTree({ ...shared, member }, member, memberTree)
    expect(titles(memberTree)).toEqual(["Written before Ada"])
  })

  it("does not take a change from a member who may only read", async () => {
    const shared = await aSharedNotebook("read")
    const ownerTree = new Y.Doc()
    const ownerSide = await openTree(shared, shared.owner, ownerTree)

    const memberTree = new Y.Doc()
    const memberSide = await openTree(shared, shared.member, memberTree)
    memberTree.getMap("nodes").set("note_9", { name: "Renamed by a reader" })
    await memberSide.leave()
    await ownerSide.engine.sync()
    await ownerSide.engine.flush()

    expect(titles(ownerTree)).toEqual([])
    expect(ownerSide.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
  })

  /** No writer lock on the tree, so two tabs write at once. Lanes keep them apart. */
  it("keeps two tabs of one device from overwriting each other's numbering", async () => {
    const shared = await aSharedNotebook()
    const first = new Y.Doc()
    const second = new Y.Doc()
    const firstTab = await openTree(shared, shared.owner, first)
    const secondTab = await openTree(shared, shared.owner, second)

    first.getMap("nodes").set("a", { name: "From the first tab" })
    second.getMap("nodes").set("b", { name: "From the second tab" })
    await firstTab.leave()
    await secondTab.leave()

    const memberTree = new Y.Doc()
    await openTree(shared, shared.member, memberTree)
    expect(titles(memberTree)).toEqual(["From the first tab", "From the second tab"])
  })
})

describe("republishing only when something may be missing", () => {
  /** Every open used to publish the whole document again, and the relay kept them all. */
  it("publishes nothing when nothing changed since the last time", async () => {
    const relay = new MemoryRelay()
    const channel = await directoryChannel(NOTEBOOK)
    const { owner, directory } = await aNotebook()
    const unsent = anUnsentFlag(directory)
    unsent.set = true

    await (await openDirectory(relay, channel, directory, owner, unsent)).leave()
    const held = relay.size
    expect(unsent.get()).toBe(false)

    await (await openDirectory(relay, channel, directory, owner, unsent)).leave()
    await (await openDirectory(relay, channel, directory, owner, unsent)).leave()
    expect(relay.size).toBe(held)
  })

  /** Written while nothing could deliver it, then the tab closed. */
  it("publishes what an earlier session never delivered", async () => {
    const relay = new MemoryRelay()
    const channel = await directoryChannel(NOTEBOOK)
    const { owner, directory } = await aNotebook()
    const unsent = anUnsentFlag(directory)
    await (await openDirectory(relay, channel, directory, owner, unsent)).leave()
    expect(unsent.get()).toBe(false)

    directory.getMap("directory:invitations").set("offline", { written: "offline" })
    expect(unsent.get()).toBe(true)
    await (await openDirectory(relay, channel, directory, owner, unsent)).leave()

    const elsewhere = new Y.Doc()
    await (await openDirectory(relay, channel, elsewhere, await aDevice())).leave()
    expect(elsewhere.getMap("directory:invitations").get("offline")).toEqual({ written: "offline" })
    expect(unsent.get()).toBe(false)
  })

  it("republishes to a relay that has lost everything", async () => {
    const channel = await directoryChannel(NOTEBOOK)
    const { owner, directory } = await aNotebook()
    const unsent = anUnsentFlag(directory)
    await (await openDirectory(new MemoryRelay(), channel, directory, owner, unsent)).leave()

    // A restarted relay remembers nothing.
    const restarted = new MemoryRelay()
    await (await openDirectory(restarted, channel, directory, owner, unsent)).leave()
    expect(restarted.size).toBeGreaterThan(0)

    const other = new Y.Doc()
    await (await openDirectory(restarted, channel, other, await aDevice())).leave()
    expect(other.getMap("workspace:genesis").size).toBe(1)
  })
})
