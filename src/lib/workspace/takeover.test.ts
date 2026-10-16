import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, putAdmission, putDeviceRecord } from "@/lib/directory"
import { createDeviceAdmission, createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { generateRecoveryCode, recoveryKeyOf } from "./recovery-code"
import { mayEditNote } from "./sharing"
import { nameStandbyDevice, recoverWithCode, takeOverAsStandby } from "./takeover"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** Maren's laptop founded it with a recovery code, linked her phone, and let Ada in to edit. */
async function aNotebook() {
  const doc = new Y.Doc()
  const laptop = await aDevice()
  const code = generateRecoveryCode(NOTEBOOK)
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: laptop, label: "Maren", recovery: await recoveryKeyOf(code.secret) })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: laptop })
  const phone = await aDevice()
  await linkIntoNotebook({ doc, notebookId: NOTEBOOK, parent: laptop, record: phone.record })
  const ada = await admit(doc, laptop, laptop.did, "Ada")
  const owner = async () => (await readNotebookWorkspace({ doc, notebookId: NOTEBOOK })).ownership.owner
  const isMember = async (device: DeviceIdentity) =>
    (await readNotebookWorkspace({ doc, notebookId: NOTEBOOK, selfDid: device.did })).self !== null
  const keysOf = async (device: DeviceIdentity) =>
    readNotebookKeys({ doc, notebookId: NOTEBOOK, device, owner: await owner() })
  return { doc, laptop, phone, ada, code, owner, isMember, keysOf }
}

async function admit(doc: Y.Doc, admin: DeviceIdentity, owner: string, label: string) {
  const device = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin, secret, label })
  const redemption = await redeemIntoNotebook({ doc, secret, device })
  await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner: admin, ownerDid: owner, invitation, redemption, ability: "write" })
  return device
}

describe("a named device taking over", () => {
  it("owns the notebook, keeps everyone the old owner let in, and shuts the lost laptop out", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
    await takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })

    expect(await notebook.owner()).toBe(notebook.phone.did)
    expect(await notebook.isMember(notebook.ada)).toBe(true)
    expect((await notebook.keysOf(notebook.ada)).current).toBe(true)
    expect(await mayEditNote({ doc: notebook.doc, notebookId: NOTEBOOK, noteId: "kyoto", owner: notebook.phone.did, did: notebook.ada.did })).toBe(true)
    expect((await notebook.keysOf(notebook.phone)).current).toBe(true)
    expect(await notebook.isMember(notebook.laptop)).toBe(false)
    expect((await notebook.keysOf(notebook.laptop)).current).toBe(false)
  })

  it("can let someone else in afterwards", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
    await takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })
    const bob = await admit(notebook.doc, notebook.phone, notebook.phone.did, "Bob")

    expect(await notebook.isMember(bob)).toBe(true)
    expect((await notebook.keysOf(bob)).current).toBe(true)
  })

  it("is refused to a device the owner did not name", async () => {
    const notebook = await aNotebook()
    await expect(takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })).rejects.toThrow(/not named/)
  })

  /** The lost laptop keeps its key. What it signs once taken over from is nobody's word. */
  it("honours nothing the lost laptop signs afterwards", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
    await takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })

    const mallory = await aDevice()
    putDeviceRecord(notebook.doc, mallory.record)
    putAdmission(
      notebook.doc,
      await createDeviceAdmission({
        adminSigningKey: notebook.laptop.signingKey,
        adminDid: notebook.laptop.did,
        record: mallory.record,
        member: "member:mallory",
        label: "Mallory",
        workspace: workspaceIdFor(NOTEBOOK),
      }),
    )
    expect(await notebook.isMember(mallory)).toBe(false)
  })
})

describe("recovering with the code", () => {
  /** Every device lost: a new one holds nothing, and the code gives it the notebook back. */
  it("makes a new device the owner, able to read everything written before", async () => {
    const notebook = await aNotebook()
    const fresh = await aDevice()
    const next = await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: fresh, code: notebook.code })

    expect(await notebook.owner()).toBe(fresh.did)
    const keys = await notebook.keysOf(fresh)
    expect(keys.current).toBe(true)
    expect(keys.readableEpochs).toContain(1)
    expect(await notebook.isMember(notebook.ada)).toBe(true)
    expect((await notebook.keysOf(notebook.ada)).current).toBe(true)
    expect((await notebook.keysOf(notebook.laptop)).current).toBe(false)
    expect(next.text).not.toBe(notebook.code.text)
  })

  it("does not recover with the code it replaced", async () => {
    const notebook = await aNotebook()
    await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: await aDevice(), code: notebook.code })

    await expect(
      recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: await aDevice(), code: notebook.code }),
    ).rejects.toThrow(/not this notebook's recovery code/)
  })

  /** The next code reads what was written since, too: every new segment is sealed to it. */
  it("recovers again with the next code, after more changes", async () => {
    const notebook = await aNotebook()
    const first = await aDevice()
    const next = await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: first, code: notebook.code })
    await admit(notebook.doc, first, first.did, "Bob")
    const second = await aDevice()
    await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: second, code: next })

    expect(await notebook.owner()).toBe(second.did)
    expect((await notebook.keysOf(second)).current).toBe(true)
    expect(await notebook.isMember(notebook.ada)).toBe(true)
  })

  /** After the named phone took over, the code still settles it - and keeps what the phone did. */
  it("takes over from an owner who took over, keeping both owners' work", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
    await takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })
    const bob = await admit(notebook.doc, notebook.phone, notebook.phone.did, "Bob")
    const fresh = await aDevice()
    await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: fresh, code: notebook.code })

    expect(await notebook.owner()).toBe(fresh.did)
    expect(await notebook.isMember(notebook.ada)).toBe(true)
    expect(await notebook.isMember(bob)).toBe(true)
    expect((await notebook.keysOf(bob)).current).toBe(true)
  })
})
