import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { readCapabilities } from "./capabilities"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, resourceIdFor } from "./notebook-workspace"
import { noteResourceId } from "./note-sync"
import { changeAccess, grantAccess, mayEditNote, withdrawGrants } from "./sharing"

const NOTEBOOK = "travel"
const YEAR = 365 * 24 * 60 * 60 * 1000

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** Maren's notebook, with Ada in it able to read and nothing more. */
async function aNotebook() {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner })
  const ada = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc, secret, device: ada })
  await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "read" })
  const base = { doc, notebookId: NOTEBOOK, owner: owner.did, device: owner }
  const may = (device: DeviceIdentity, noteId: string) =>
    mayEditNote({ doc, notebookId: NOTEBOOK, noteId, owner: owner.did, did: device.did })
  const grantsTo = async (did: string, resource: string) =>
    (await readCapabilities(doc)).filter((capability) => capability.payload.aud === did && capability.payload.rsc === resource)
  return { doc, owner, ada, base, may, grantsTo }
}

describe("who may edit a note", () => {
  it("lets a member who can only read edit one note they are given", async () => {
    const notebook = await aNotebook()
    expect(await notebook.may(notebook.ada, "kyoto")).toBe(false)

    await grantAccess({ ...notebook.base, audience: notebook.ada.did, resource: noteResourceId(NOTEBOOK, "kyoto"), ability: "write", expiresAt: Date.now() + YEAR })
    expect(await notebook.may(notebook.ada, "kyoto")).toBe(true)
    expect(await notebook.may(notebook.ada, "osaka")).toBe(false)
  })

  it("takes it back when the grant is withdrawn", async () => {
    const notebook = await aNotebook()
    const note = noteResourceId(NOTEBOOK, "kyoto")
    await grantAccess({ ...notebook.base, audience: notebook.ada.did, resource: note, ability: "write", expiresAt: Date.now() + YEAR })
    await withdrawGrants({ ...notebook.base, grants: await notebook.grantsTo(notebook.ada.did, note) })

    expect(await notebook.may(notebook.ada, "kyoto")).toBe(false)
  })

  /** A new grant and the old one withdrawn, so the level is what was chosen, not the stronger of two. */
  it("changes a member's level for the whole notebook, both ways", async () => {
    const notebook = await aNotebook()
    const whole = resourceIdFor(NOTEBOOK)
    await changeAccess({ ...notebook.base, audience: notebook.ada.did, resource: whole, ability: "write", expiresAt: Date.now() + YEAR, replacing: await notebook.grantsTo(notebook.ada.did, whole) })
    expect(await notebook.may(notebook.ada, "osaka")).toBe(true)

    await changeAccess({ ...notebook.base, audience: notebook.ada.did, resource: whole, ability: "read", expiresAt: Date.now() + YEAR, replacing: await notebook.grantsTo(notebook.ada.did, whole) })
    expect(await notebook.may(notebook.ada, "osaka")).toBe(false)
  })

  /** Ada's phone writes as Ada, so it may edit exactly what she may. */
  it("holds a member's linked phone to the member's access", async () => {
    const notebook = await aNotebook()
    const phone = await aDevice()
    await linkIntoNotebook({ doc: notebook.doc, notebookId: NOTEBOOK, parent: notebook.ada, record: phone.record })
    expect(await notebook.may(phone, "kyoto")).toBe(false)

    await grantAccess({ ...notebook.base, audience: notebook.ada.did, resource: noteResourceId(NOTEBOOK, "kyoto"), ability: "write", expiresAt: Date.now() + YEAR })
    expect(await notebook.may(phone, "kyoto")).toBe(true)
  })

  /** The owner's phone is the owner, and shares as one. */
  it("lets the owner's phone give access", async () => {
    const notebook = await aNotebook()
    const phone = await aDevice()
    await linkIntoNotebook({ doc: notebook.doc, notebookId: NOTEBOOK, parent: notebook.owner, record: phone.record })
    await grantAccess({ ...notebook.base, device: phone, audience: notebook.ada.did, resource: noteResourceId(NOTEBOOK, "kyoto"), ability: "write", expiresAt: Date.now() + YEAR })

    expect(await notebook.may(notebook.ada, "kyoto")).toBe(true)
  })

  /** Managing access stays with the owner's devices; a grant of it would not be honoured. */
  it("does not give anyone management of access", async () => {
    const notebook = await aNotebook()
    await expect(
      grantAccess({ ...notebook.base, audience: notebook.ada.did, resource: resourceIdFor(NOTEBOOK), ability: "admin", expiresAt: Date.now() + YEAR }),
    ).rejects.toThrow(/owner/)
  })
})
