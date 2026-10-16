import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { signEpochRecord } from "@/lib/membership"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { linkIntoNotebook } from "./linking"
import { foundNotebookKeys, putEpochRecord, readNotebookKeys, storedEpochRecords, keyDomainFor } from "./notebook-keys"
import { foundNotebookWorkspace, readNotebookWorkspace } from "./notebook-workspace"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function aNotebook() {
  const doc = new Y.Doc()
  const laptop = await aDevice()
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: laptop, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: laptop })
  const phone = await aDevice()
  await linkIntoNotebook({ doc, notebookId: NOTEBOOK, parent: laptop, record: phone.record })
  return { doc, laptop, phone }
}

async function admitOn(doc: Y.Doc, admin: DeviceIdentity, owner: string, label: string) {
  const device = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin, secret, label })
  const redemption = await redeemIntoNotebook({ doc, secret, device })
  await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner: admin, ownerDid: owner, invitation, redemption, ability: "write" })
  return device
}

const keysOf = (doc: Y.Doc, device: DeviceIdentity, owner: string) =>
  readNotebookKeys({ doc, notebookId: NOTEBOOK, device, owner })

describe("records nobody can take back", () => {
  /**
   * Each cuts the next epoch. An admission's key is derived the same way on
   * both, so whichever record stands, both people's copies open it.
   */
  it("keeps both people two of the owner's devices let in at once", async () => {
    const { doc, laptop, phone } = await aNotebook()
    const owner = laptop.did
    const elsewhere = new Y.Doc()
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(doc))

    const ada = await admitOn(doc, laptop, owner, "Ada")
    const bob = await admitOn(elsewhere, phone, owner, "Bob")
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(elsewhere))

    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK })
    expect(workspace.directory!.devices.map((device) => device.record.did)).toEqual(expect.arrayContaining([ada.did, bob.did]))
    for (const device of [laptop, phone, ada, bob]) {
      expect((await keysOf(doc, device, owner)).current).toBe(true)
    }
  })

  /** A member can write to the directory. A record they sign for the next epoch is not anyone's key. */
  it("does not let a member's epoch record stop anyone's keys", async () => {
    const { doc, laptop } = await aNotebook()
    const ada = await admitOn(doc, laptop, laptop.did, "Ada")
    const [latest] = storedEpochRecords(doc, keyDomainFor(NOTEBOOK)).slice(-1)
    const next = { ...latest.record, epoch: latest.record.epoch + 1 }
    putEpochRecord(doc, await signEpochRecord(next, ada.signingKey, ada.did))
    putEpochRecord(doc, await signEpochRecord(latest.record, ada.signingKey, ada.did))

    for (const device of [laptop, ada]) {
      const keys = await keysOf(doc, device, laptop.did)
      expect(keys.access).toBe("reader")
      expect(keys.current).toBe(true)
    }
  })
})
