import * as Y from "yjs"
import { afterEach, describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

import { foundNotebookWorkspace, readNotebookWorkspace } from "./notebook-workspace"
import { configureOwnerPins, memoryOwnerPins, pinnedOwner, pinOwner } from "./owner-pins"

const NOTEBOOK = "travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

async function withRival() {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
  const read = () => readNotebookWorkspace({ doc, notebookId: NOTEBOOK })
  return { doc, owner, read, rival: async () => foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: await aDevice(), label: "Mallory" }) }
}

afterEach(() => configureOwnerPins(null))

describe("remembering who owns a notebook", () => {
  /** Anyone who can write to the directory can add a claim of their own. */
  it("keeps the owner once established, whatever claims arrive since", async () => {
    configureOwnerPins(memoryOwnerPins())
    const notebook = await withRival()
    expect((await notebook.read()).ownership.owner).toBe(notebook.owner.did)

    await notebook.rival()
    expect((await notebook.read()).ownership).toMatchObject({ status: "established", owner: notebook.owner.did })
  })

  it("is what stops a rival claim disputing it", async () => {
    const notebook = await withRival()
    await notebook.read()
    await notebook.rival()
    expect((await notebook.read()).ownership.status).toBe("disputed")
  })

  it("never replaces an owner already remembered", () => {
    configureOwnerPins(memoryOwnerPins())
    pinOwner(NOTEBOOK, "did:key:zFirst")
    pinOwner(NOTEBOOK, "did:key:zSecond")
    expect(pinnedOwner(NOTEBOOK)).toBe("did:key:zFirst")
  })
})
