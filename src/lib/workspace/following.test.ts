import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { MemoryRelay } from "@/lib/sync"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import {
  announcementSlot,
  hasAnnouncement,
  inboxChannel,
  openAnnouncements,
  putAnnouncement,
  signAnnouncement,
} from "./announcements"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace } from "./notebook-workspace"
import { ownDevicesIn } from "./own-devices"
import { createDirectoryReplica } from "./replicas"
import { removeFromNotebook } from "./removal"
import { unlinkDevice } from "./unlinking"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

let count = 0

/** A notebook its owner founded, with Ada let in on her laptop. */
async function aNotebook(owner: DeviceIdentity, adaLaptop: DeviceIdentity) {
  const notebookId = `follow${String((count += 1))}`
  const doc = new Y.Doc()
  await foundNotebookWorkspace({ doc, notebookId, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId, device: owner })
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId, admin: owner, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc, secret, device: adaLaptop })
  await admitFromRedemption({ doc, notebookId, owner, invitation, redemption, ability: "write" })
  return { doc, notebookId }
}

describe("which devices are this one's own", () => {
  it("are the devices linked with it, not other members or the owner", async () => {
    const [maren, adaLaptop, adaPhone] = [await aDevice(), await aDevice(), await aDevice()]
    const notebook = await aNotebook(maren, adaLaptop)
    await linkIntoNotebook({ doc: notebook.doc, notebookId: notebook.notebookId, parent: adaLaptop, record: adaPhone.record })

    expect([...(await ownDevicesIn(adaLaptop, [notebook])).keys()]).toEqual([adaPhone.did])
    expect([...(await ownDevicesIn(adaPhone, [notebook])).keys()]).toEqual([adaLaptop.did])
    expect([...(await ownDevicesIn(maren, [notebook])).keys()]).toEqual([])
  })

  it("leave out a device unlinked anywhere, though another notebook still has it", async () => {
    const [maren, adaLaptop, adaPhone] = [await aDevice(), await aDevice(), await aDevice()]
    const travel = await aNotebook(maren, adaLaptop)
    const work = await aNotebook(maren, adaLaptop)
    for (const notebook of [travel, work]) {
      await linkIntoNotebook({ doc: notebook.doc, notebookId: notebook.notebookId, parent: adaLaptop, record: adaPhone.record })
    }
    // The unlinking reached one notebook and not the other.
    await unlinkDevice({ doc: travel.doc, notebookId: travel.notebookId, actor: adaLaptop, did: adaPhone.did })

    expect((await ownDevicesIn(adaLaptop, [travel, work])).has(adaPhone.did)).toBe(false)
  })

  it("still follow a person someone else took out of their notebook", async () => {
    const [maren, ada, laptop, phone] = [await aDevice(), await aDevice(), await aDevice(), await aDevice()]
    const theirs = await aNotebook(ada, laptop)
    const mine = await aNotebook(maren, laptop)
    for (const notebook of [theirs, mine]) {
      await linkIntoNotebook({ doc: notebook.doc, notebookId: notebook.notebookId, parent: laptop, record: phone.record })
    }
    const workspace = await readNotebookWorkspace({ doc: theirs.doc, notebookId: theirs.notebookId })
    const entry = workspace.directory?.devices.find((device) => device.record.did === laptop.did)
    if (entry?.kind !== "admitted") throw new Error("laptop is not admitted")
    await removeFromNotebook({ doc: theirs.doc, notebookId: theirs.notebookId, owner: ada, member: entry.admission.member })

    expect((await ownDevicesIn(laptop, [theirs, mine])).has(phone.did)).toBe(true)
  })

  it("count nothing from a notebook this device was taken out of", async () => {
    const [maren, adaLaptop, adaPhone] = [await aDevice(), await aDevice(), await aDevice()]
    const notebook = await aNotebook(maren, adaLaptop)
    await linkIntoNotebook({ doc: notebook.doc, notebookId: notebook.notebookId, parent: adaLaptop, record: adaPhone.record })
    const workspace = await readNotebookWorkspace({ doc: notebook.doc, notebookId: notebook.notebookId })
    const laptop = workspace.directory?.devices.find((device) => device.record.did === adaLaptop.did)
    if (laptop?.kind !== "admitted") throw new Error("laptop is not admitted")
    await removeFromNotebook({ doc: notebook.doc, notebookId: notebook.notebookId, owner: maren, member: laptop.admission.member })

    expect((await ownDevicesIn(adaLaptop, [notebook])).size).toBe(0)
  })
})

describe("announcing a notebook to one of your devices", () => {
  async function anInbox(device: DeviceIdentity, relay: MemoryRelay, as: DeviceIdentity) {
    const channel = await inboxChannel(device.record.sealingDid)
    const doc = new Y.Doc()
    const engine = createDirectoryReplica({ doc, channel, device: as, transport: relay.attach(as.did) })
    await engine.sync()
    return { doc, engine, channel }
  }

  it("reaches the device it is for, and nobody else can read it - the relay included", async () => {
    const relay = new MemoryRelay()
    const [laptop, phone] = [await aDevice(), await aDevice()]
    const sent = await anInbox(phone, relay, laptop)
    const slot = await announcementSlot(laptop.signingKey, "work", phone.did)
    const announcement = await signAnnouncement(laptop.signingKey, { notebookId: "work", name: "Work", owner: laptop.did, by: laptop.did, to: phone.did })
    await putAnnouncement(sent.doc, slot, phone.record.sealingDid, announcement)
    await sent.engine.flush()

    const received = await anInbox(phone, relay, phone)
    const [opened] = await openAnnouncements(received.doc, phone.sealingKey, phone.did, (sender) => sender === laptop.did)
    expect(opened).toMatchObject({ notebookId: "work", name: "Work", by: laptop.did })

    // Another member knows the phone's record, so can find the inbox - and still reads nothing.
    const stranger = await aDevice()
    const looking = await anInbox(phone, relay, stranger)
    expect(await openAnnouncements(looking.doc, stranger.sealingKey, stranger.did, () => true)).toEqual([])
    const stored = JSON.stringify(relay.stored())
    expect(stored).not.toContain("Work")
    expect(sent.channel.resourceId).not.toContain(phone.did)
  })

  it("is ignored when its signature is not its sender's, or it is for another device", async () => {
    const relay = new MemoryRelay()
    const [laptop, phone, forger] = [await aDevice(), await aDevice(), await aDevice()]
    const inbox = await anInbox(phone, relay, forger)
    // Claims the laptop sent it.
    const forged = await signAnnouncement(forger.signingKey, { notebookId: "trap", name: "Trap", owner: forger.did, by: laptop.did, to: phone.did })
    await putAnnouncement(inbox.doc, "a", phone.record.sealingDid, forged)
    const elsewhere = await signAnnouncement(laptop.signingKey, { notebookId: "work", name: "Work", owner: laptop.did, by: laptop.did, to: forger.did })
    await putAnnouncement(inbox.doc, "b", phone.record.sealingDid, elsewhere)
    inbox.doc.getMap("announcements").set("c", "not a box")

    expect(await openAnnouncements(inbox.doc, phone.sealingKey, phone.did, () => true)).toEqual([])
  })

  it("is ignored from a device that is not one of its own, however well signed", async () => {
    const relay = new MemoryRelay()
    const [laptop, phone, stranger] = [await aDevice(), await aDevice(), await aDevice()]
    const inbox = await anInbox(phone, relay, stranger)
    const genuine = await signAnnouncement(stranger.signingKey, { notebookId: "trap", name: "Trap", owner: stranger.did, by: stranger.did, to: phone.did })
    await putAnnouncement(inbox.doc, "a", phone.record.sealingDid, genuine)

    expect(await openAnnouncements(inbox.doc, phone.sealingKey, phone.did, (sender) => sender === laptop.did)).toEqual([])
  })

  it("is filed where only its sender can find it again, so it is put back rather than sent twice", async () => {
    const [laptop, phone, other] = [await aDevice(), await aDevice(), await aDevice()]
    const slot = await announcementSlot(laptop.signingKey, "work", phone.did)
    expect(await announcementSlot(laptop.signingKey, "work", phone.did)).toBe(slot)
    expect(await announcementSlot(other.signingKey, "work", phone.did)).not.toBe(slot)
    expect(await announcementSlot(laptop.signingKey, "travel", phone.did)).not.toBe(slot)

    const doc = new Y.Doc()
    expect(hasAnnouncement(doc, slot)).toBe(false)
    const announcement = await signAnnouncement(laptop.signingKey, { notebookId: "work", name: "Work", owner: laptop.did, by: laptop.did, to: phone.did })
    await putAnnouncement(doc, slot, phone.record.sealingDid, announcement)
    expect(hasAnnouncement(doc, slot)).toBe(true)
  })
})
