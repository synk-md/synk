import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateAeadKey, generateSealingKey, generateSigningKey, toBase64Url, type Bytes } from "@/lib/crypto"
import { generateInvitationSecret, readDirectory } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { sealEpochKey, type EpochRecord, type SealedEpochKey } from "@/lib/keys"
import { signEpochRecord } from "@/lib/membership"

import { admitFromRedemption, inviteToNotebook, redeemIntoNotebook } from "./admission"
import {
  commitCurrentKey,
  foundNotebookKeys,
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  storedEpochRecords,
} from "./notebook-keys"
import { foundNotebookWorkspace, workspaceIdFor } from "./notebook-workspace"
import { removeFromNotebook } from "./removal"

const NOTEBOOK = "travel"
const DOMAIN = keyDomainFor(NOTEBOOK)

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function admit(doc: Y.Doc, owner: DeviceIdentity, device: DeviceIdentity, label: string) {
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin: owner, secret, label })
  const redemption = await redeemIntoNotebook({ doc, secret, device })
  await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner, invitation, redemption, ability: "write" })
}

async function aNotebook() {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: owner, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner })
  const ada = await aDevice()
  const grace = await aDevice()
  await admit(doc, owner, ada, "Ada")
  await admit(doc, owner, grace, "Grace")
  return { doc, owner, ada, grace }
}

type Notebook = Awaited<ReturnType<typeof aNotebook>>

const keysOf = (notebook: Notebook, device: DeviceIdentity) =>
  readNotebookKeys({ doc: notebook.doc, notebookId: NOTEBOOK, device, owner: notebook.owner.did })

async function currentKey(notebook: Notebook, device: DeviceIdentity): Promise<string | null> {
  const keys = await keysOf(notebook, device)
  const key = keys.keyring ? await keys.keyring.keyFor(keys.keyring.currentEpoch) : undefined
  return key ? toBase64Url(key) : null
}

/** A box anybody holding the link could file: a key of the attacker's choosing, sealed to the victim. */
async function plant(notebook: Notebook, victim: DeviceIdentity, epoch: number, key: Bytes): Promise<SealedEpochKey> {
  const planted = await sealEpochKey(DOMAIN, epoch, victim.record.sealingDid, key)
  putSealedKeys(notebook.doc, [planted])
  // Also where a copy used to live alone, which is how replacing one worked.
  notebook.doc
    .getMap<SealedEpochKey>("workspace:keyring")
    .set(`${planted.domain}|${String(planted.epoch)}|${planted.recipient}`, planted)
  return planted
}

describe("planting a key", () => {
  /**
   * The attack removal existed to stop: the removed member, still holding the
   * link, files a key they know for someone who stays, so that person's next
   * writes are sealed where the removed member can read them.
   */
  it("does not work for a removed member against someone who stays", async () => {
    const notebook = await aNotebook()
    const directory = await readDirectory(notebook.doc, [notebook.owner.did], { workspace: workspaceIdFor(NOTEBOOK) })
    const adaEntry = directory.devices.find((device) => device.record.did === notebook.ada.did)
    if (adaEntry?.kind !== "admitted") throw new Error("ada is not admitted")
    const { epoch } = await removeFromNotebook({
      doc: notebook.doc,
      notebookId: NOTEBOOK,
      owner: notebook.owner,
      member: adaEntry.admission.member,
    })

    const known = generateAeadKey()
    await plant(notebook, notebook.grace, epoch, known)

    expect(await currentKey(notebook, notebook.grace)).toBe(await currentKey(notebook, notebook.owner))
    expect(await currentKey(notebook, notebook.grace)).not.toBe(toBase64Url(known))
  })

  it("does not work for an outsider against a member", async () => {
    const notebook = await aNotebook()
    const keys = await keysOf(notebook, notebook.ada)
    const known = generateAeadKey()
    await plant(notebook, notebook.ada, keys.keyring!.currentEpoch, known)

    expect(await currentKey(notebook, notebook.ada)).toBe(await currentKey(notebook, notebook.owner))
  })

  /** With the genuine copy gone, the planted one is all there is - and it is not used. */
  it("leaves a device holding only a planted key unable to seal, not sealing for the planter", async () => {
    const notebook = await aNotebook()
    const keyring = notebook.doc.getMap<SealedEpochKey>("workspace:keyring")
    for (const [slot, copy] of [...keyring.entries()]) {
      if (copy.recipient === notebook.grace.record.sealingDid) keyring.delete(slot)
    }
    const latest = storedEpochRecords(notebook.doc, DOMAIN).length
    await plant(notebook, notebook.grace, latest, generateAeadKey())

    const keys = await keysOf(notebook, notebook.grace)
    expect(keys.access).toBe("untrusted-keys")
    expect(keys.keyring).toBeNull()
  })
})

function withoutCommitment(record: EpochRecord): EpochRecord {
  const copy = { ...record }
  delete copy.commitment
  return copy
}

describe("epochs from before commitments", () => {
  /** What every notebook created before this change looks like. */
  /** A notebook from before commitments: its records, without them, and nothing else. */
  async function withoutCommitments(notebook: Notebook) {
    const records = storedEpochRecords(notebook.doc, DOMAIN)
    notebook.doc.getMap("workspace:epochs").clear()
    for (const signed of records) {
      putEpochRecord(
        notebook.doc,
        await signEpochRecord(withoutCommitment(signed.record), notebook.owner.signingKey, notebook.owner.did),
      )
    }
  }

  it("still open, so existing notebooks keep working", async () => {
    const notebook = await aNotebook()
    await withoutCommitments(notebook)

    const keys = await keysOf(notebook, notebook.ada)
    expect(keys.access).toBe("reader")
    expect(keys.current).toBe(true)
  })

  /** Signed with the record, so taking it away breaks the record rather than the check. */
  it("cannot be faked by stripping the commitment from a signed record", async () => {
    const notebook = await aNotebook()
    const [signed] = storedEpochRecords(notebook.doc, DOMAIN)
    putEpochRecord(notebook.doc, { ...signed, record: withoutCommitment(signed.record) })

    expect((await keysOf(notebook, notebook.ada)).access).toBe("untrusted-timeline")
  })

  /**
   * The owner's next open cuts a committed chain step. A device fooled into
   * holding a planted key for the old epoch derives a key that fails it.
   */
  it("get a commitment from the owner, which then exposes a planted key", async () => {
    const notebook = await aNotebook()
    await withoutCommitments(notebook)
    const latest = storedEpochRecords(notebook.doc, DOMAIN).length
    const known = generateAeadKey()
    await plant(notebook, notebook.ada, latest, known)

    expect(await commitCurrentKey({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.owner })).toBe(true)
    expect(await commitCurrentKey({ doc: notebook.doc, notebookId: NOTEBOOK, owner: notebook.owner })).toBe(false)

    expect(await currentKey(notebook, notebook.ada)).toBe(await currentKey(notebook, notebook.owner))
  })
})
