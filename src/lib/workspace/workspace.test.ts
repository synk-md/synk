import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { putAdmission, putDeviceRecord } from "@/lib/directory"
import {
  createDeviceAdmission,
  createDeviceRecord,
  didFromSigningKey,
  type DeviceIdentity,
} from "@/lib/identity"

import { createGenesis, resolveOwnership, verifyGenesis } from "./genesis"
import {
  foundNotebookWorkspace,
  genesisClaims,
  memberIdFor,
  putGenesis,
  readNotebookWorkspace,
  resourceIdFor,
  workspaceIdFor,
} from "./notebook-workspace"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"
const WORKSPACE = workspaceIdFor(NOTEBOOK)
const RESOURCE = resourceIdFor(NOTEBOOK)

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return {
    did: didFromSigningKey(signingKey.publicKey),
    clientId: record.clientId,
    signingKey,
    sealingKey,
    record,
  }
}

/* ---- genesis ------------------------------------------------------------- */

describe("the genesis record", () => {
  it("names the owner and verifies under their key", async () => {
    const owner = await aDevice()
    const genesis = await createGenesis({
      signingKey: owner.signingKey,
      owner: owner.did,
      workspace: WORKSPACE,
      resource: RESOURCE,
      createdAt: T0,
    })

    expect(genesis.owner).toBe(owner.did)
    expect(await verifyGenesis(genesis)).toBe(true)
  })

  it("refuses a genesis whose owner did not sign it", async () => {
    const owner = await aDevice()
    const other = await aDevice()

    await expect(
      createGenesis({
        signingKey: other.signingKey,
        owner: owner.did,
        workspace: WORKSPACE,
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/does not match/)
  })

  it("refuses one scoped to another workspace or resource", async () => {
    const owner = await aDevice()
    const genesis = await createGenesis({
      signingKey: owner.signingKey,
      owner: owner.did,
      workspace: WORKSPACE,
      resource: RESOURCE,
      createdAt: T0,
    })

    expect(await verifyGenesis(genesis, { workspace: "workspace:other" })).toBe(false)
    expect(await verifyGenesis(genesis, { resource: "notebook:other" })).toBe(false)
  })

  /**
   * The honest limit. A signature says who wrote it, not that they were first,
   * so an expected owner is what turns authorship into authority.
   */
  it("refuses a rival claim when the owner is already known", async () => {
    const owner = await aDevice()
    const attacker = await aDevice()
    const rival = await createGenesis({
      signingKey: attacker.signingKey,
      owner: attacker.did,
      workspace: WORKSPACE,
      resource: RESOURCE,
      createdAt: T0,
    })

    expect(await verifyGenesis(rival)).toBe(true)
    expect(await verifyGenesis(rival, { expectedOwner: owner.did })).toBe(false)
  })

  it("reports two rival claims as disputed rather than picking one", async () => {
    const owner = await aDevice()
    const attacker = await aDevice()
    const claims = await Promise.all(
      [owner, attacker].map((device) =>
        createGenesis({
          signingKey: device.signingKey,
          owner: device.did,
          workspace: WORKSPACE,
          resource: RESOURCE,
          createdAt: T0,
        }),
      ),
    )

    const ownership = await resolveOwnership(claims, { workspace: WORKSPACE })
    expect(ownership.status).toBe("disputed")
    expect(ownership.owner).toBeNull()
    expect(ownership.claims).toHaveLength(2)

    // Knowing the owner settles it.
    const settled = await resolveOwnership(claims, { expectedOwner: owner.did })
    expect(settled.status).toBe("established")
    expect(settled.owner).toBe(owner.did)
  })
})

/* ---- founding ------------------------------------------------------------ */

describe("founding a notebook workspace", () => {
  it("writes a genesis, the owner's record and a self-admission together", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()

    const founded = await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })

    expect(founded.workspace).toBe(WORKSPACE)
    expect(founded.resource).toBe(RESOURCE)
    expect(genesisClaims(doc)).toHaveLength(1)

    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      selfDid: owner.did,
      now: T0,
    })

    expect(workspace.ownership.status).toBe("established")
    expect(workspace.ownership.owner).toBe(owner.did)
    expect(workspace.self?.record.did).toBe(owner.did)
    expect(workspace.users).toHaveLength(1)
  })

  it("is idempotent, so reopening a notebook does not add a rival claim", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()

    const first = await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })
    const second = await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0 + 5000,
    })

    expect(second.genesis.createdAt).toBe(first.genesis.createdAt)
    expect(genesisClaims(doc)).toHaveLength(1)
  })

  it("attests the owner's label, so it is not self-asserted", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })

    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK, now: T0 })
    const device = workspace.directory?.devices[0]

    expect(device?.kind).toBe("admitted")
    expect(device?.kind === "admitted" && device.admission.label).toBe("Maren")
  })
})

/* ---- reading ------------------------------------------------------------- */

describe("reading a notebook workspace", () => {
  it("reports no directory until ownership is established", async () => {
    const doc = new Y.Doc()

    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK, now: T0 })

    expect(workspace.ownership.status).toBe("none")
    expect(workspace.directory).toBeNull()
    expect(workspace.users).toEqual([])
  })

  /**
   * The circularity this ordering exists to avoid: taking the admin set from
   * the directory would let anyone who can write to the document admit
   * themselves.
   */
  it("ignores an admission signed by someone who is not the owner", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    const attacker = await aDevice()

    await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })

    // The attacker publishes their own record and admits themselves.
    const selfAdmission = await createDeviceAdmission({
      adminSigningKey: attacker.signingKey,
      adminDid: attacker.did,
      record: attacker.record,
      member: memberIdFor(attacker.did),
      label: "Totally Legitimate",
      workspace: WORKSPACE,
      issuedAt: T0,
    })
    putDeviceRecord(doc, attacker.record)
    putAdmission(doc, selfAdmission)

    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      selfDid: owner.did,
      now: T0,
    })

    expect(workspace.directory?.devices.map((device) => device.record.did)).toEqual([owner.did])
    expect(workspace.users).toHaveLength(1)
  })

  it("admits a second device once the owner signs for it", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    const colleague = await aDevice()

    await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })

    const admission = await createDeviceAdmission({
      adminSigningKey: owner.signingKey,
      adminDid: owner.did,
      record: colleague.record,
      member: memberIdFor(colleague.did),
      label: "Ada",
      workspace: WORKSPACE,
      issuedAt: T0,
    })
    putDeviceRecord(doc, colleague.record)
    putAdmission(doc, admission)

    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK, now: T0 })

    expect(workspace.directory?.devices).toHaveLength(2)
    expect(workspace.users.map((user) => user.userId).sort()).toEqual(
      [memberIdFor(owner.did), memberIdFor(colleague.did)].sort(),
    )
  })

  /** A rival genesis written into a merged document must not silently take over. */
  it("refuses to name an owner while two claims stand", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    const attacker = await aDevice()

    await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      label: "Maren",
      createdAt: T0,
    })
    putGenesis(
      doc,
      await createGenesis({
        signingKey: attacker.signingKey,
        owner: attacker.did,
        workspace: WORKSPACE,
        resource: RESOURCE,
        createdAt: T0,
      }),
    )

    const disputed = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK, now: T0 })
    expect(disputed.ownership.status).toBe("disputed")
    expect(disputed.directory).toBeNull()

    // Someone who arrived by invitation knows the owner, and is unaffected.
    const settled = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      expectedOwner: owner.did,
      now: T0,
    })
    expect(settled.ownership.owner).toBe(owner.did)
    expect(settled.directory?.devices).toHaveLength(1)
  })

  it("drops a genesis misfiled under another key", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    const genesis = await createGenesis({
      signingKey: owner.signingKey,
      owner: owner.did,
      workspace: WORKSPACE,
      resource: RESOURCE,
      createdAt: T0,
    })
    doc.getMap(GENESIS_MAP_NAME).set("did:key:zSomeoneElse", genesis)

    // Read by what it says: it is the owner's claim, whatever it was filed under.
    expect(genesisClaims(doc).map((claim) => claim.owner)).toEqual([owner.did])
  })
})

const GENESIS_MAP_NAME = "workspace:genesis"
