import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, readDirectory } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { MemoryRelay, type SyncEngine } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine } from "./note-sync"
import { removeFromNotebook } from "./removal"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** The owner, and Ada - admitted on her laptop - who will link her phone. */
async function aNotebook(ability: "read" | "write" = "write") {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const laptop = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc: directory, secret, device: laptop })
  await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability })
  return { directory, owner, laptop, phone: await aDevice(), relay: new MemoryRelay() }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

interface Client {
  doc: Y.Doc
  engine: SyncEngine
  rekey(): Promise<void>
}

async function open(notebook: Notebook, device: DeviceIdentity): Promise<Client> {
  const read = async () => {
    const keys = await readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })
    if (!keys.keyring) throw new Error(`no keys for ${device.did}: ${keys.access}`)
    return keys.keyring
  }
  let keyring: ReadKeySource = await read()
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
  await engine.sync()
  return {
    doc,
    engine,
    rekey: async () => {
      keyring = await read()
    },
  }
}

async function settle(...clients: Client[]) {
  for (let round = 0; round < 4; round += 1) {
    for (const client of clients) await client.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const write = (client: Client, text: string) =>
  client.engine.transact(() => client.doc.getText("body").insert(client.doc.getText("body").length, text))
const text = (client: Client) => client.doc.getText("body").toJSON()

const link = (notebook: Notebook, parent = notebook.laptop, record = notebook.phone.record) =>
  linkIntoNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, parent, record })

describe("linking another of your own devices", () => {
  /** A joiner sees from today onwards. Your own phone should see what you see. */
  it("reads what was written before it was linked", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    write(owner, "Written before the phone existed.")
    await settle(owner)

    // Someone else joins, so that writing is now an epoch behind. Keys only
    // derive forwards: the phone has to be handed the older one.
    const grace = await aDevice()
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      admin: notebook.owner,
      secret,
      label: "Grace",
    })
    const redemption = await redeemIntoNotebook({ doc: notebook.directory, secret, device: grace })
    await admitFromRedemption({ doc: notebook.directory, notebookId: NOTEBOOK, owner: notebook.owner, invitation, redemption })

    expect(await link(notebook)).toBe("linked")
    const phone = await open(notebook, notebook.phone)
    await settle(phone)

    expect(text(phone)).toBe("Written before the phone existed.")
  })

  it("writes, and is accepted, under the grant of the device that linked it", async () => {
    const notebook = await aNotebook()
    await link(notebook)
    const owner = await open(notebook, notebook.owner)
    const phone = await open(notebook, notebook.phone)

    write(phone, "From Ada's phone.")
    await settle(phone, owner)

    expect(text(owner)).toBe("From Ada's phone.")
    expect(owner.engine.stats.rejected.unauthorized).toBe(0)
  })

  it("counts as the same person, not another member", async () => {
    const notebook = await aNotebook()
    await link(notebook)

    const workspace = await readNotebookWorkspace({ doc: notebook.directory, notebookId: NOTEBOOK })
    expect(workspace.users).toHaveLength(2)
    const ada = workspace.users.find((user) => user.devices.some((device) => device.record.did === notebook.laptop.did))
    expect(ada?.devices.map((device) => device.record.did).sort()).toEqual(
      [notebook.laptop.did, notebook.phone.did].sort(),
    )
  })

  /** It can do exactly what its parent can - no more. */
  it("may only read where the device that linked it may only read", async () => {
    const notebook = await aNotebook("read")
    await link(notebook)
    const owner = await open(notebook, notebook.owner)
    const phone = await open(notebook, notebook.phone)

    write(phone, "Should not land.")
    await settle(phone, owner)

    expect(text(owner)).toBe("")
    expect(owner.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
  })

  it("goes when the person it belongs to is removed", async () => {
    const notebook = await aNotebook()
    await link(notebook)
    const owner = await open(notebook, notebook.owner)
    const phone = await open(notebook, notebook.phone)

    const directory = await readDirectory(notebook.directory, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
    const laptop = directory.devices.find((device) => device.record.did === notebook.laptop.did)
    if (laptop?.kind !== "admitted") throw new Error("laptop is not admitted")
    const { devices } = await removeFromNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      owner: notebook.owner,
      member: laptop.admission.member,
    })
    expect(devices.sort()).toEqual([notebook.laptop.did, notebook.phone.did].sort())

    const keys = await readNotebookKeys({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      device: notebook.phone,
      owner: notebook.owner.did,
    })
    expect(keys.current).toBe(false)

    write(phone, "After removal.")
    await settle(phone, owner)
    expect(text(owner)).toBe("")
  })
})

describe("what linking will not do", () => {
  /** A link is a leaf. Otherwise one admission would fan out without an admin ever seeing it. */
  it("will not let a linked device link another", async () => {
    const notebook = await aNotebook()
    await link(notebook)
    const tablet = await aDevice()

    await expect(link(notebook, notebook.phone, tablet.record)).rejects.toThrow(/only a device admitted/)
  })

  it("will not link from a device that is not a member", async () => {
    const notebook = await aNotebook()
    const stranger = await aDevice()
    await expect(link(notebook, stranger)).rejects.toThrow(/not a member/)
  })

  it("refuses a record its own keys did not sign", async () => {
    const notebook = await aNotebook()
    const forged = { ...notebook.phone.record, clientId: notebook.phone.record.clientId + 1 }
    await expect(link(notebook, notebook.laptop, forged)).rejects.toThrow(/does not verify/)
  })

  it("does nothing the second time", async () => {
    const notebook = await aNotebook()
    expect(await link(notebook)).toBe("linked")
    expect(await link(notebook)).toBe("already-present")
  })
})
