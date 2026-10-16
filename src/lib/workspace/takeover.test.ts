import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret, putAdmission, putDeviceRecord } from "@/lib/directory"
import { canAdminister, isAuthorized, issueCapability } from "@/lib/authz"
import { createDeviceAdmission, createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { generateRecoveryCode, recoveryKeyOf } from "./recovery-code"
import { mayEditNote } from "./sharing"
import { authorizationContext, putCapability, readCapabilities } from "./capabilities"
import { resourceIdFor } from "./notebook-workspace"
import { acceptOwnership, nameStandbyDevice, recoverWithCode, takeOverAsStandby } from "./takeover"

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

  /** Someone the owner's phone let in, as the owner, before everything was lost. */
  it("keeps someone a deputy of the old owner let in", async () => {
    const notebook = await aNotebook()
    const bob = await admit(notebook.doc, notebook.phone, notebook.laptop.did, "Bob")
    await recoverWithCode({ doc: notebook.doc, notebookId: NOTEBOOK, device: await aDevice(), code: notebook.code })

    expect(await notebook.isMember(bob)).toBe(true)
    expect((await notebook.keysOf(bob)).current).toBe(true)
    expect(await mayEditNote({ doc: notebook.doc, notebookId: NOTEBOOK, noteId: "kyoto", owner: (await notebook.owner())!, did: bob.did })).toBe(true)
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

/** Not lost, only handed on: the laptop stays, as one of Maren's devices like any other. */
describe("handing ownership over", () => {
  it("makes the device the owner offered it to the owner, keeping the old one in and reading", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did, handover: true })
    await acceptOwnership({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })

    expect(await notebook.owner()).toBe(notebook.phone.did)
    expect(await notebook.isMember(notebook.laptop)).toBe(true)
    expect((await notebook.keysOf(notebook.laptop)).current).toBe(true)
    expect(await notebook.isMember(notebook.ada)).toBe(true)
    expect((await notebook.keysOf(notebook.ada)).current).toBe(true)
    const workspace = await readNotebookWorkspace({ doc: notebook.doc, notebookId: NOTEBOOK })
    expect(workspace.directory?.admins).toEqual([notebook.phone.did])
    // An ordinary device of Maren's now, and one she writes on.
    expect(await mayEditNote({ doc: notebook.doc, notebookId: NOTEBOOK, noteId: "kyoto", owner: notebook.phone.did, did: notebook.laptop.did })).toBe(true)
  })

  it("lets the new owner let someone in, and not the old one", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did, handover: true })
    await acceptOwnership({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })

    const bob = await admit(notebook.doc, notebook.phone, notebook.phone.did, "Bob")
    expect(await notebook.isMember(bob)).toBe(true)
    const mallory = await admit(notebook.doc, notebook.laptop, notebook.phone.did, "Mallory").catch(() => null)
    expect(mallory === null || !(await notebook.isMember(mallory))).toBe(true)
  })

  /** Named only for if the laptop is lost is not the same as being offered it now. */
  it("is refused to a device that was only named for a loss", async () => {
    const notebook = await aNotebook()
    await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
    await expect(acceptOwnership({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })).rejects.toThrow(/not offered/)
  })
})

/**
 * The old owner's root is kept so what was granted under it stands. It must
 * not leave the old owner an admin: a lost laptop could cut keys everyone
 * follows, or grant anyone anything.
 */
describe("what the old owner keeps", () => {
  for (const [how, pass] of [
    ["after a takeover", async (notebook: Awaited<ReturnType<typeof aNotebook>>) => {
      await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did })
      await takeOverAsStandby({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })
    }],
    ["after a handover", async (notebook: Awaited<ReturnType<typeof aNotebook>>) => {
      await nameStandbyDevice({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.laptop, device: notebook.phone.did, handover: true })
      await acceptOwnership({ doc: notebook.doc, notebookId: NOTEBOOK, device: notebook.phone })
    }],
  ] as const) {
    it(`is no authority over the notebook ${how}`, async () => {
      const notebook = await aNotebook()
      await pass(notebook)
      const resource = resourceIdFor(NOTEBOOK)
      const context = await authorizationContext(notebook.doc, notebook.phone.did)

      expect(await canAdminister(notebook.laptop.did, resource, context)).toBe(false)
      expect(await canAdminister(notebook.phone.did, resource, context)).toBe(true)
    })

    it(`cannot grant anyone anything new ${how}`, async () => {
      const notebook = await aNotebook()
      await pass(notebook)
      const root = (await readCapabilities(notebook.doc)).find(
        (capability) => capability.payload.iss === notebook.laptop.did && capability.payload.prf === null,
      )!
      const mallory = await aDevice()
      putCapability(
        notebook.doc,
        await issueCapability({
          signingKey: notebook.laptop.signingKey,
          issuer: notebook.laptop.did,
          audience: mallory.did,
          resource: resourceIdFor(NOTEBOOK),
          ability: "write",
          proof: root.cid,
          expiresAt: Date.now() + 60_000,
        }),
      )
      const context = await authorizationContext(notebook.doc, notebook.phone.did)
      expect(await isAuthorized({ principal: mallory.did, resource: resourceIdFor(NOTEBOOK), ability: "write" }, context)).toBe(false)
      // What the laptop granted before still stands.
      expect(await isAuthorized({ principal: notebook.ada.did, resource: resourceIdFor(NOTEBOOK), ability: "write" }, context)).toBe(true)
    })
  }
})

