import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import {
  generateInvitationSecret,
  putAdmission,
  putDeviceRecord,
  putLink,
  putRatification,
  ratify,
  valuesIn,
  verifyInvitation,
} from "@/lib/directory"
import {
  createDeviceAdmission,
  createDeviceLink,
  createDeviceRecord,
  didFromSigningKey,
  type DeviceAdmission,
  type DeviceIdentity,
} from "@/lib/identity"
import { MemoryRelay } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, matchInvitation, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { readNotebookKeys } from "./notebook-keys"
import { foundNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { liveKeys } from "./note-relay"
import { createNoteSyncEngine } from "./note-sync"
import { removeFromNotebook } from "./removal"
import { unlinkDevice } from "./unlinking"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** Sindre's laptop founded the notebook; his phone is linked to it. */
async function aNotebook() {
  const directory = new Y.Doc()
  const laptop = await aDevice()
  await foundNotebookWorkspace({ doc: directory, notebookId: NOTEBOOK, device: laptop, label: "Sindre" })
  await foundNotebookKeys({ doc: directory, notebookId: NOTEBOOK, device: laptop })
  const phone = await aDevice()
  await linkIntoNotebook({ doc: directory, notebookId: NOTEBOOK, parent: laptop, record: phone.record })
  return { directory, laptop, phone, owner: laptop.did }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

/** Invited and admitted by `admin` - the laptop, or the phone acting as Sindre. */
async function admit(notebook: Notebook, admin: DeviceIdentity, label: string) {
  const device = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, admin, secret, label })
  const redemption = await redeemIntoNotebook({ doc: notebook.directory, secret, device })
  const admitted = await admitFromRedemption({
    doc: notebook.directory,
    notebookId: NOTEBOOK,
    owner: admin,
    ownerDid: notebook.owner,
    invitation,
    redemption,
    ability: "write",
  })
  return { device, member: admitted.member }
}

async function workspaceAs(notebook: Notebook, device: DeviceIdentity) {
  return readNotebookWorkspace({ doc: notebook.directory, notebookId: NOTEBOOK, selfDid: device.did })
}

const isMember = async (notebook: Notebook, device: DeviceIdentity) =>
  (await workspaceAs(notebook, device)).self !== null

async function keysOf(notebook: Notebook, device: DeviceIdentity) {
  return readNotebookKeys({ doc: notebook.directory, notebookId: NOTEBOOK, device, owner: notebook.owner })
}

/** Whether what `writer` writes reaches Sindre's laptop, which checks it like any peer. */
async function writingArrives(notebook: Notebook, writer: DeviceIdentity): Promise<boolean> {
  const relay = new MemoryRelay()
  const open = async (device: DeviceIdentity) => {
    const keys = await keysOf(notebook, device)
    if (!keys.keyring) throw new Error(`no keys for ${device.did}: ${keys.access}`)
    const keyring = keys.keyring
    const doc = new Y.Doc()
    doc.clientID = device.clientId
    const engine = createNoteSyncEngine({
      doc,
      notebookId: NOTEBOOK,
      noteId: "kyoto",
      index: notebook.directory,
      owner: notebook.owner,
      author: device.did,
      signingKey: device.signingKey,
      clientId: device.clientId,
      keys: liveKeys(() => keyring),
      transport: relay.attach(device.did),
    })
    return { doc, engine }
  }
  const from = await open(writer)
  const to = await open(notebook.laptop)
  from.engine.transact(() => from.doc.getText("body").insert(0, "Hello."))
  for (let round = 0; round < 4; round += 1) {
    await from.engine.flush()
    await to.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return to.doc.getText("body").toJSON() === "Hello."
}

describe("the owner's own devices act as the owner", () => {
  it("counts the phone as an admin, and a member's phone as not", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.laptop, "Ada")
    const adasPhone = await aDevice()
    await linkIntoNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, parent: ada.device, record: adasPhone.record })

    const admins = (await workspaceAs(notebook, notebook.laptop)).directory!.admins
    expect(admins).toContain(notebook.phone.did)
    expect(admins).not.toContain(adasPhone.did)
  })

  /** Away from the laptop, the phone can still let someone in. */
  it("lets the phone admit someone, who can then read and write", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.phone, "Ada")

    expect(await isMember(notebook, ada.device)).toBe(true)
    expect((await keysOf(notebook, ada.device)).current).toBe(true)
    expect((await keysOf(notebook, notebook.laptop)).current).toBe(true)
    expect(await writingArrives(notebook, ada.device)).toBe(true)
  })

  it("lets the phone take someone out", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.laptop, "Ada")
    await removeFromNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      owner: notebook.phone,
      ownerDid: notebook.owner,
      member: ada.member,
    })

    expect(await isMember(notebook, ada.device)).toBe(false)
    expect((await keysOf(notebook, ada.device)).current).toBe(false)
    expect((await keysOf(notebook, notebook.laptop)).current).toBe(true)
  })

  /** A member's own phone writes as them, but is no more an admin than they are. */
  it("does not let a member's phone admit anyone", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.laptop, "Ada")
    const adasPhone = await aDevice()
    await linkIntoNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, parent: ada.device, record: adasPhone.record })

    const outsider = await admit(notebook, adasPhone, "Mallory").catch(() => null)
    expect(outsider === null || !(await isMember(notebook, outsider.device))).toBe(true)
  })
})

describe("unlinking one of the owner's devices", () => {
  /** Its work was the owner's work. Unlinking a lost phone must not undo it. */
  it("keeps everyone the phone let in, able to read and write", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.phone, "Ada")
    await unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor: notebook.laptop, did: notebook.phone.did })

    expect(await isMember(notebook, notebook.phone)).toBe(false)
    expect(await isMember(notebook, ada.device)).toBe(true)
    expect((await keysOf(notebook, ada.device)).current).toBe(true)
    expect((await keysOf(notebook, notebook.laptop)).current).toBe(true)
    expect(await writingArrives(notebook, ada.device)).toBe(true)
  })

  /** Otherwise unlinking would bring back whoever it removed. */
  it("keeps everyone the phone took out, out", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.laptop, "Ada")
    await removeFromNotebook({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      owner: notebook.phone,
      ownerDid: notebook.owner,
      member: ada.member,
    })
    await unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor: notebook.laptop, did: notebook.phone.did })

    expect(await isMember(notebook, ada.device)).toBe(false)
    expect((await keysOf(notebook, notebook.laptop)).current).toBe(true)
  })

  /** A lost phone keeps its key. What it signs once unlinked is nobody's word. */
  it("honours nothing the phone signs afterwards", async () => {
    const notebook = await aNotebook()
    await unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor: notebook.laptop, did: notebook.phone.did })

    const outsider = await admit(notebook, notebook.phone, "Mallory").catch(() => null)
    expect(outsider === null || !(await isMember(notebook, outsider.device))).toBe(true)
  })

  /** Keeping is the owner's to do; a member cannot keep what a lost phone signs. */
  it("honours a keeping only from the owner", async () => {
    const notebook = await aNotebook()
    const ada = await admit(notebook, notebook.laptop, "Ada")
    await unlinkDevice({ doc: notebook.directory, notebookId: NOTEBOOK, actor: notebook.laptop, did: notebook.phone.did })
    // Signed by the lost phone after it was unlinked, as if letting someone in.
    const mallory = await aDevice()
    const admission = await createDeviceAdmission({
      adminSigningKey: notebook.phone.signingKey,
      adminDid: notebook.phone.did,
      record: mallory.record,
      member: "member:mallory",
      label: "Mallory",
      workspace: workspaceIdFor(NOTEBOOK),
    })
    putDeviceRecord(notebook.directory, mallory.record)
    putAdmission(notebook.directory, admission)
    expect(await isMember(notebook, mallory)).toBe(false)

    putRatification(
      notebook.directory,
      await ratify({
        signingKey: ada.device.signingKey,
        admin: ada.device.did,
        workspace: workspaceIdFor(NOTEBOOK),
        device: notebook.phone.did,
        kept: [admission.sig],
      }),
    )
    expect(await isMember(notebook, mallory)).toBe(false)
  })
})

/** Somebody invited from the phone checks the notebook against who signed the invitation. */
describe("joining by an invitation from the owner's phone", () => {
  it("finds the owner the phone acts for", async () => {
    const notebook = await aNotebook()
    const { secret } = generateInvitationSecret()
    await inviteToNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, admin: notebook.phone, secret, label: "Ada" })

    const match = await matchInvitation(notebook.directory, secret)
    expect(match?.invitation.admin).toBe(notebook.phone.did)
    const workspace = await readNotebookWorkspace({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      expectedOwner: match!.expectedOwner,
    })
    expect(workspace.ownership).toMatchObject({ status: "established", owner: notebook.laptop.did })
  })

  /**
   * Links are filed one per device, so a rival who can write to the directory
   * can re-link the phone under a genesis of their own. The invitation names
   * the owner, so that does not make the rival the owner to whoever joins.
   */
  it("does not let a rival who re-links the phone become the owner", async () => {
    const notebook = await aNotebook()
    const { secret } = generateInvitationSecret()
    await inviteToNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, admin: notebook.phone, secret, label: "Ada" })
    const rival = await aDevice()
    await foundNotebookWorkspace({ doc: notebook.directory, notebookId: NOTEBOOK, device: rival, label: "Mallory" })
    const rivalAdmission = valuesIn<DeviceAdmission>(notebook.directory, "directory:admissions").find((each) => each.did === rival.did)!
    putLink(
      notebook.directory,
      await createDeviceLink({
        parentSigningKey: rival.signingKey,
        parentAdmission: rivalAdmission,
        record: notebook.phone.record,
        issuedAt: Date.now(),
      }),
    )

    const match = await matchInvitation(notebook.directory, secret)
    const workspace = await readNotebookWorkspace({
      doc: notebook.directory,
      notebookId: NOTEBOOK,
      expectedOwner: match!.expectedOwner,
    })
    expect(workspace.ownership.owner).toBe(notebook.laptop.did)
  })
})

it("signs the owner an invitation names", async () => {
  const notebook = await aNotebook()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc: notebook.directory, notebookId: NOTEBOOK, admin: notebook.phone, secret, label: "Ada" })
  const admins = [notebook.laptop.did, notebook.phone.did]

  expect(invitation.owner).toBe(notebook.laptop.did)
  expect(await verifyInvitation(invitation, admins)).toBe(true)
  expect(await verifyInvitation({ ...invitation, owner: notebook.phone.did }, admins)).toBe(false)
})
