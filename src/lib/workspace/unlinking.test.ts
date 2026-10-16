import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, putLinkRevocation, readDirectory, valuesIn } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity, type DeviceLink } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { revokeLink } from "@/lib/membership"
import { MemoryRelay, type SyncEngine } from "@/lib/sync"

import { admitFromRedemption, hasAdmittedMembers, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine } from "./note-sync"
import { removeFromNotebook } from "./removal"
import { rotateAway, unlinkDevice } from "./unlinking"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function admit(directory: Y.Doc, owner: DeviceIdentity, device: DeviceIdentity, label: string) {
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: directory, notebookId: NOTEBOOK, admin: owner, secret, label })
  const redemption = await redeemIntoNotebook({ doc: directory, secret, device })
  await admitFromRedemption({ doc: directory, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
}

/** The owner, Ada on her laptop with her phone linked, and Grace. */
async function aNotebook() {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const laptop = await aDevice()
  const grace = await aDevice()
  await admit(directory, owner, laptop, "Ada")
  await admit(directory, owner, grace, "Grace")
  const phone = await aDevice()
  await linkIntoNotebook({ doc: directory, notebookId: NOTEBOOK, parent: laptop, record: phone.record })
  return { directory, owner, laptop, grace, phone, relay: new MemoryRelay() }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

const keysOf = (notebook: Notebook, device: DeviceIdentity) =>
  readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })

const present = async (notebook: Notebook, device: DeviceIdentity) => {
  const directory = await readDirectory(notebook.directory, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
  return directory.devices.some((entry) => entry.record.did === device.did)
}

interface Client {
  doc: Y.Doc
  engine: SyncEngine
  rekey(): Promise<void>
}

async function open(notebook: Notebook, device: DeviceIdentity): Promise<Client> {
  const read = async () => {
    const keys = await keysOf(notebook, device)
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

const unlinkPhone = (notebook: Notebook, actor = notebook.laptop) =>
  unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor, did: notebook.phone.did })

const rotate = (notebook: Notebook, owner = notebook.owner) =>
  rotateAway({ doc: notebook.directory, notebookId: NOTEBOOK, owner })

describe("unlinking a lost phone", () => {
  it("stops its writes being accepted as soon as the news arrives", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const phone = await open(notebook, notebook.phone)

    expect(await unlinkPhone(notebook)).toBe("unlinked")
    expect(await present(notebook, notebook.phone)).toBe(false)

    write(phone, "Written by whoever has the phone.")
    await settle(phone, owner)
    expect(text(owner)).toBe("")
    expect(owner.engine.stats.rejected["unknown-author"]).toBeGreaterThan(0)
  })

  /**
   * Until the owner replaces the key the phone can still derive it. That gap
   * is real, so it is checked rather than wished away - and then closed.
   */
  it("leaves it able to read new writing only until the owner rotates", async () => {
    const notebook = await aNotebook()
    await unlinkPhone(notebook)
    expect((await keysOf(notebook, notebook.phone)).current).toBe(true)

    expect(await rotate(notebook)).toBe(true)
    expect((await keysOf(notebook, notebook.phone)).current).toBe(false)

    const owner = await open(notebook, notebook.owner)
    const phone = await open(notebook, notebook.phone)
    write(owner, "After the rotation.")
    await settle(owner, phone)
    expect(text(phone)).toBe("")
  })

  it("keeps everyone else working under the new key", async () => {
    const notebook = await aNotebook()
    await unlinkPhone(notebook)
    await rotate(notebook)

    const laptop = await open(notebook, notebook.laptop)
    const grace = await open(notebook, notebook.grace)
    write(laptop, "From Ada's laptop. ")
    await settle(laptop, grace)
    write(grace, "And Grace.")
    await settle(laptop, grace)
    expect(text(laptop)).toBe("From Ada's laptop. And Grace.")
  })

  /** The case that had no way out: the owner's own phone, and the owner cannot be removed. */
  it("lets the owner cut off their own lost phone", async () => {
    const notebook = await aNotebook()
    const ownersPhone = await aDevice()
    await linkIntoNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, parent: notebook.owner, record: ownersPhone.record })

    expect(
      await unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor: notebook.owner, did: ownersPhone.did }),
    ).toBe("unlinked")
    expect(await rotate(notebook)).toBe(true)

    const keys = await keysOf(notebook, ownersPhone)
    expect(keys.current).toBe(false)
  })
})

describe("rotating only when it is needed", () => {
  it("does not rotate when nobody taken out can reach the key", async () => {
    const notebook = await aNotebook()
    expect(await rotate(notebook)).toBe(false)
  })

  it("rotates once, not on every open", async () => {
    const notebook = await aNotebook()
    await unlinkPhone(notebook)
    expect(await rotate(notebook)).toBe(true)
    expect(await rotate(notebook)).toBe(false)
  })

  /** Removing a person already rotates; nothing is left for this to do. */
  it("has nothing to do after a removal", async () => {
    const notebook = await aNotebook()
    const directory = await readDirectory(notebook.directory, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
    const ada = directory.devices.find((device) => device.record.did === notebook.laptop.did)
    if (ada?.kind !== "admitted") throw new Error("ada is not admitted")
    await removeFromNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, owner: notebook.owner, member: ada.admission.member })

    expect(await rotate(notebook)).toBe(false)
  })

  it("does nothing on a device that is not the owner's", async () => {
    const notebook = await aNotebook()
    await unlinkPhone(notebook)
    expect(await rotate(notebook, notebook.laptop)).toBe(false)
  })
})

describe("who may unlink", () => {
  it("refuses someone else's device", async () => {
    const notebook = await aNotebook()
    await expect(unlinkPhone(notebook, notebook.grace)).rejects.toThrow(/own approved devices/)
  })

  it("refuses the linked device itself", async () => {
    const notebook = await aNotebook()
    const tablet = await aDevice()
    await linkIntoNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, parent: notebook.laptop, record: tablet.record })
    await expect(unlinkPhone(notebook, tablet)).rejects.toThrow(/own approved devices/)
  })

  /** Anyone holding the link can file a record. Only the member's own signature counts. */
  it("ignores an unlinking nobody entitled signed", async () => {
    const notebook = await aNotebook()
    const link = valuesIn<DeviceLink>(notebook.directory, "directory:links").find((each) => each.did === notebook.phone.did)!
    putLinkRevocation(
      notebook.directory,
      await revokeLink({ signingKey: notebook.grace.signingKey, revoker: notebook.grace.did, link }),
    )
    expect(await present(notebook, notebook.phone)).toBe(true)
  })

  it("lets the same device be linked again later", async () => {
    const notebook = await aNotebook()
    await unlinkPhone(notebook)
    await linkIntoNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      parent: notebook.laptop,
      record: notebook.phone.record,
      // After the unlinking, which is what lets the new link stand.
      now: Date.now() + 5,
    })
    expect(await present(notebook, notebook.phone)).toBe(true)
  })
})

describe("a notebook used alone again", () => {
  /** Otherwise its sync keeps running for a phone that holds nothing any more. */
  it("stops counting as shared once its only other device is unlinked", async () => {
    const directory = new Y.Doc()
    const owner = await aDevice()
    await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Maren" })
    await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
    const phone = await aDevice()
    await linkIntoNotebook({ doc: directory, notebookId: NOTEBOOK, parent: owner, record: phone.record })
    expect(hasAdmittedMembers(directory)).toBe(true)

    await unlinkDevice({ doc: directory, notebookId: NOTEBOOK, actor: owner, did: phone.did })
    expect(hasAdmittedMembers(directory)).toBe(false)
  })
})
