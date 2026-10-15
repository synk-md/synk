import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateInvitationSecret, putRemoval, readDirectory, removeDevice, valuesIn } from "@/lib/directory"
import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceAdmission, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { revokeCapability } from "@/lib/authz"
import { MemoryRelay, type SyncEngine } from "@/lib/sync"

import {
  admitFromRedemption,
  hasAdmittedMembers,
  inviteToNotebook,
  pendingRedemptions,
  redeemIntoNotebook,
} from "./admission"
import { putRevocation, readCapabilities } from "./capabilities"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine } from "./note-sync"
import { indexPresenceScope, presenceRoom } from "./presence"
import { removeFromNotebook } from "./removal"

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

/** Owner, Ada who will be removed, and Grace who stays. */
async function aNotebook() {
  const directory = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
  const ada = await aDevice()
  const grace = await aDevice()
  await admit(directory, owner, ada, "Ada")
  await admit(directory, owner, grace, "Grace")
  return { directory, owner, ada, grace, relay: new MemoryRelay() }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

const memberOf = async (notebook: Notebook, device: DeviceIdentity) => {
  const directory = await readDirectory(notebook.directory, [notebook.owner.did], {
    workspace: workspaceIdFor(NOTEBOOK),
  })
  const entry = directory.devices.find((candidate) => candidate.record.did === device.did)
  return entry?.kind === "admitted" ? entry.admission.member : null
}

interface Client {
  doc: Y.Doc
  engine: SyncEngine
  /** Re-read this device's keys, as the app does on every directory change. */
  rekey(): Promise<void>
}

/** A note open on one device, its keys read through as the app reads them. */
async function open(notebook: Notebook, device: DeviceIdentity): Promise<Client> {
  const read = async () => {
    const keys = await readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })
    if (!keys.keyring) throw new Error(`no keys for ${device.did}`)
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

async function removeAda(notebook: Notebook) {
  return removeFromNotebook({
    doc: notebook.directory,
    notebookId: NOTEBOOK,
    owner: notebook.owner,
    member: (await memberOf(notebook, notebook.ada))!,
  })
}

describe("removing a member", () => {
  it("leaves them unable to read anything written afterwards", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const ada = await open(notebook, notebook.ada)

    write(owner, "before. ")
    await settle(owner, ada)
    expect(text(ada)).toBe("before. ")

    await removeAda(notebook)
    await owner.rekey()
    await ada.rekey()
    write(owner, "after.")
    await settle(owner, ada)

    expect(text(owner)).toBe("before. after.")
    expect(text(ada)).toBe("before. ")
    expect(ada.engine.stats.rejected["unknown-epoch"]).toBeGreaterThan(0)
  })

  it("keeps everyone else working, under the new key", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const grace = await open(notebook, notebook.grace)

    const { epoch } = await removeAda(notebook)
    await owner.rekey()
    await grace.rekey()
    write(owner, "from the owner. ")
    await settle(owner, grace)
    write(grace, "and from Grace.")
    await settle(owner, grace)

    expect(text(grace)).toBe("from the owner. and from Grace.")
    expect(text(owner)).toBe("from the owner. and from Grace.")
    expect(notebook.relay.stored().every((envelope) => envelope.epoch === epoch)).toBe(true)
  })

  /**
   * A device that has not heard, or will not listen, keeps sealing under the
   * key it already had. Everybody else turns it away.
   */
  it("has their writes refused by everyone who has heard", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const ada = await open(notebook, notebook.ada)

    await removeAda(notebook)
    // Ada does not re-read: her engine still holds the epoch she was given.
    write(ada, "written after being removed.")
    await settle(owner, ada)

    expect(text(owner)).toBe("")
    expect(owner.engine.stats.rejected["unknown-author"]).toBeGreaterThan(0)
  })

  it("tells the removed device so, rather than calling it a reader", async () => {
    const notebook = await aNotebook()
    await removeAda(notebook)

    const keys = await readNotebookKeys({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      device: notebook.ada,
      owner: notebook.owner.did,
    })
    expect(keys.current).toBe(false)
    const remaining = await readNotebookKeys({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      device: notebook.grace,
      owner: notebook.owner.did,
    })
    expect(remaining.current).toBe(true)
  })

  it("leaves them out of the member list", async () => {
    const notebook = await aNotebook()
    await removeAda(notebook)

    const directory = await readDirectory(notebook.directory, [notebook.owner.did], {
      workspace: workspaceIdFor(NOTEBOOK),
    })
    expect(directory.devices.map((device) => device.record.did)).not.toContain(notebook.ada.did)
    expect(directory.removed.has(notebook.ada.did)).toBe(true)
  })
})

describe("what removal does not do", () => {
  /** Their old request was answered. Showing it again would invite re-admitting by mistake. */
  it("does not bring their request back for approval", async () => {
    const notebook = await aNotebook()
    await removeAda(notebook)
    expect(pendingRedemptions(notebook.directory)).toEqual([])
  })

  it("counts the notebook as unshared once only its founder remains", async () => {
    const directory = new Y.Doc()
    const owner = await aDevice()
    await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
    await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: owner })
    const ada = await aDevice()
    await admit(directory, owner, ada, "Ada")
    expect(hasAdmittedMembers(directory)).toBe(true)

    const notebook = { directory, owner, ada, grace: ada, relay: new MemoryRelay() }
    await removeAda(notebook)
    expect(hasAdmittedMembers(directory)).toBe(false)
  })

  it("does not stop them being invited back", async () => {
    const notebook = await aNotebook()
    await removeAda(notebook)

    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      admin: notebook.owner,
      secret,
      label: "Ada",
      now: Date.now() + 1,
    })
    const redemption = await redeemIntoNotebook({ doc: notebook.directory, secret, device: notebook.ada })
    expect(pendingRedemptions(notebook.directory)).toHaveLength(1)

    await admitFromRedemption({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      owner: notebook.owner,
      invitation,
      redemption,
      now: Date.now() + 2,
    })
    expect(await memberOf(notebook, notebook.ada)).not.toBeNull()
    const keys = await readNotebookKeys({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      device: notebook.ada,
      owner: notebook.owner.did,
    })
    expect(keys.current).toBe(true)
  })

  it("refuses to remove the owner", async () => {
    const notebook = await aNotebook()
    await expect(
      removeFromNotebook({
        doc: notebook.directory,
        notebookId: NOTEBOOK,
        owner: notebook.owner,
        member: (await memberOf(notebook, notebook.owner))!,
      }),
    ).rejects.toThrow(/owner cannot remove themselves/)
  })

  it("refuses when someone other than the owner tries", async () => {
    const notebook = await aNotebook()
    await expect(
      removeFromNotebook({
        doc: notebook.directory,
        notebookId: NOTEBOOK,
        owner: notebook.grace,
        member: (await memberOf(notebook, notebook.ada))!,
      }),
    ).rejects.toThrow(/only the notebook's owner/)
  })

  /** Anyone holding the link can write to the directory. Only an admin's removal counts. */
  it("ignores a removal nobody entitled signed", async () => {
    const notebook = await aNotebook()
    const directoryEntry = valuesIn<DeviceAdmission>(notebook.directory, "directory:admissions").find((each) => each.did === notebook.ada.did)!
    putRemoval(
      notebook.directory,
      await removeDevice({ signingKey: notebook.grace.signingKey, admin: notebook.grace.did, admission: directoryEntry }),
    )

    expect(await memberOf(notebook, notebook.ada)).not.toBeNull()
  })
})

describe("a revoked grant", () => {
  /** On its own, without a removal: what changing someone's level will rely on. */
  it("stops authorising writes", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const ada = await open(notebook, notebook.ada)

    for (const capability of await readCapabilities(notebook.directory)) {
      if (capability.payload.aud !== notebook.ada.did) continue
      putRevocation(
        notebook.directory,
        await revokeCapability({
          signingKey: notebook.owner.signingKey,
          issuer: notebook.owner.did,
          capabilityCid: capability.cid,
        }),
      )
    }
    write(ada, "after the grant was withdrawn.")
    await settle(owner, ada)

    expect(text(owner)).toBe("")
    expect(owner.engine.stats.rejected.unauthorized).toBeGreaterThan(0)
  })

  it("is ignored when revoked by someone with no say over it", async () => {
    const notebook = await aNotebook()
    const owner = await open(notebook, notebook.owner)
    const ada = await open(notebook, notebook.ada)

    for (const capability of await readCapabilities(notebook.directory)) {
      if (capability.payload.aud !== notebook.ada.did) continue
      putRevocation(
        notebook.directory,
        await revokeCapability({
          signingKey: notebook.grace.signingKey,
          issuer: notebook.grace.did,
          capabilityCid: capability.cid,
        }),
      )
    }
    write(ada, "still allowed.")
    await settle(owner, ada)

    expect(text(owner)).toBe("still allowed.")
  })
})

describe("presence after removal", () => {
  /** Rooms come from the current key, so a cut moves everyone else and leaves them. */
  it("moves everyone else to a room the removed member cannot name", async () => {
    const notebook = await aNotebook()
    const keysOf = (device: DeviceIdentity) =>
      readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner.did })
    const roomFor = async (device: DeviceIdentity) => {
      const keys = await keysOf(device)
      const key = keys.keyring ? await keys.keyring.keyFor(keys.keyring.currentEpoch) : undefined
      return key ? (await presenceRoom(key, indexPresenceScope(NOTEBOOK))).name : null
    }

    const before = await roomFor(notebook.owner)
    expect(await roomFor(notebook.ada)).toBe(before)

    await removeAda(notebook)

    const after = await roomFor(notebook.owner)
    expect(after).not.toBe(before)
    expect(await roomFor(notebook.grace)).toBe(after)
    expect(await roomFor(notebook.ada)).toBeNull()
  })
})
