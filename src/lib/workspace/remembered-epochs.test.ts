import * as Y from "yjs"
import { afterEach, describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { signEpochRecord, type SignedEpochRecord } from "@/lib/membership"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import { EPOCH_MAP, foundNotebookKeys, keyDomainFor, putEpochRecord, readNotebookKeys, storedEpochRecords } from "./notebook-keys"
import { foundNotebookWorkspace } from "./notebook-workspace"
import {
  configureRememberedEpochs,
  memoryRememberedEpochs,
  rememberedEpoch,
  rememberEpoch,
} from "./remembered-epochs"
import { removeFromNotebook } from "./removal"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function admit(doc: Y.Doc, owner: DeviceIdentity, label: string) {
  const device = await aDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin: owner, secret, label })
  const redemption = await redeemIntoNotebook({ doc, secret, device })
  const admitted = await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
  return { device, member: admitted.member }
}

/** Maren removed Bob, so the newest epoch is a key Bob was never given. */
async function afterARemoval() {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner })
  const ada = await admit(doc, owner, "Ada")
  const bob = await admit(doc, owner, "Bob")
  const { epoch } = await removeFromNotebook({ doc, notebookId: NOTEBOOK, owner, member: bob.member })
  const keysOf = (device: DeviceIdentity) => readNotebookKeys({ doc, notebookId: NOTEBOOK, device, owner: owner.did })
  /** What someone who can write to the directory does to take the newest epoch away. */
  const deleteNewest = () => {
    const map = doc.getMap<SignedEpochRecord>(EPOCH_MAP)
    for (const [key, signed] of map.entries()) if (signed.record.epoch === epoch) map.delete(key)
  }
  return { doc, owner, ada, bob, epoch, keysOf, deleteNewest }
}

afterEach(() => configureRememberedEpochs(null))

describe("never going back an epoch", () => {
  it("refuses a timeline missing an epoch this device has seen", async () => {
    configureRememberedEpochs(memoryRememberedEpochs())
    const notebook = await afterARemoval()
    expect((await notebook.keysOf(notebook.owner)).keyring?.currentEpoch).toBe(notebook.epoch)

    notebook.deleteNewest()
    const keys = await notebook.keysOf(notebook.owner)
    expect(keys.access).toBe("untrusted-timeline")
    expect(keys.verification?.reason).toBe("behind")
    expect(keys.keyring).toBeNull()
  })

  /** Without it, this device would write under a key the removed member holds. */
  it("is what stops a device writing under a key someone removed still holds", async () => {
    const notebook = await afterARemoval()
    await notebook.keysOf(notebook.owner)
    notebook.deleteNewest()

    const keys = await notebook.keysOf(notebook.owner)
    expect(keys.keyring?.currentEpoch).toBe(notebook.epoch - 1)
    expect((await notebook.keysOf(notebook.bob.device)).readableEpochs).toContain(notebook.epoch - 1)
  })

  /** A member's record for an epoch that never was must not become what this device expects. */
  it("is not raised by junk past the last real epoch", async () => {
    configureRememberedEpochs(memoryRememberedEpochs())
    const notebook = await afterARemoval()
    const [latest] = storedEpochRecords(notebook.doc, keyDomainFor(NOTEBOOK)).slice(-1)
    const junk = await signEpochRecord({ ...latest.record, epoch: notebook.epoch + 1 }, notebook.ada.device.signingKey, notebook.ada.device.did)
    putEpochRecord(notebook.doc, junk)

    expect((await notebook.keysOf(notebook.owner)).access).toBe("reader")
    expect(rememberedEpoch(NOTEBOOK)).toBe(notebook.epoch)
  })

  it("only ever raises what it remembers", () => {
    configureRememberedEpochs(memoryRememberedEpochs())
    rememberEpoch(NOTEBOOK, 5)
    rememberEpoch(NOTEBOOK, 3)
    expect(rememberedEpoch(NOTEBOOK)).toBe(5)
  })
})
