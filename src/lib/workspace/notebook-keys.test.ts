import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import {
  createDeviceRecord,
  didFromSigningKey,
  type DeviceIdentity,
} from "@/lib/identity"
import { signEpochRecord } from "@/lib/membership"
import { genesisEpoch } from "@/lib/keys"

import { authorizationContext, issueOwnerRoot, ownerHoldsRoot, putCapability } from "./capabilities"
import {
  foundNotebookKeys,
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  restoreDomainAdmin,
  storedEpochRecords,
  storedSealedKeys,
} from "./notebook-keys"
import { foundNotebookWorkspace, resourceIdFor } from "./notebook-workspace"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"
const DOMAIN = keyDomainFor(NOTEBOOK)
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

async function founded(): Promise<{ doc: Y.Doc; owner: DeviceIdentity }> {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({
    doc,
    notebookId: NOTEBOOK,
    device: owner,
    label: "Sindre",
    createdAt: T0,
  })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner, createdAt: T0 })
  return { doc, owner }
}

/* ---- the owner's root ---------------------------------------------------- */

describe("the owner's root capability", () => {
  /**
   * Without it the owner holds admin nowhere, and signing an epoch record is
   * itself admin-gated - so the record founding writes would fail its own
   * verification on the next read.
   */
  it("is issued at founding, so the owner can assert an epoch at all", async () => {
    const { doc, owner } = await founded()
    expect(await ownerHoldsRoot(doc, owner.did, RESOURCE, T0)).toBe(true)
  })

  it("is worthless when issued by anyone other than the owner", async () => {
    const doc = new Y.Doc()
    const owner = await aDevice()
    const attacker = await aDevice()

    // Identical shape, issued to themselves. It just does not reach the owner.
    putCapability(
      doc,
      await issueOwnerRoot({
        signingKey: attacker.signingKey,
        owner: attacker.did,
        resource: RESOURCE,
        now: T0,
      }),
    )

    expect(await ownerHoldsRoot(doc, owner.did, RESOURCE, T0)).toBe(false)

    const context = await authorizationContext(doc, owner.did, T0)
    const record = await signEpochRecord(
      genesisEpoch(DOMAIN, T0),
      attacker.signingKey,
      attacker.did,
    )
    putEpochRecord(doc, record)

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: attacker,
      owner: owner.did,
      now: T0,
      context,
    })
    expect(keys.access).toBe("untrusted-timeline")
    expect(keys.verification?.reason).toBe("unauthorized-asserter")
  })
})

/* ---- founding ------------------------------------------------------------ */

describe("founding a notebook's keys", () => {
  it("writes a signed genesis epoch and a sealed copy for the owner", async () => {
    const { doc, owner } = await founded()

    expect(storedEpochRecords(doc, DOMAIN)).toHaveLength(1)
    const sealed = storedSealedKeys(doc, DOMAIN)
    expect(sealed).toHaveLength(1)
    expect(sealed[0].recipient).toBe(owner.record.sealingDid)
  })

  it("gives the owner a reader view over the genesis epoch", async () => {
    const { doc, owner } = await founded()

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      owner: owner.did,
      now: T0,
    })

    expect(keys.access).toBe("reader")
    expect(keys.readableEpochs).toEqual([1])
    expect(await keys.keyring?.keyFor(1)).toBeDefined()
  })

  it("is idempotent, so reopening does not cut a second genesis", async () => {
    const { doc, owner } = await founded()
    await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner, createdAt: T0 + 5000 })

    expect(storedEpochRecords(doc, DOMAIN)).toHaveLength(1)
  })

  /** Live key material is never written; only sealed boxes and structure. */
  it("stores nothing a non-member could open", async () => {
    const { doc, owner } = await founded()
    const stranger = await aDevice()

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: stranger,
      owner: owner.did,
      now: T0,
    })

    expect(keys.access).toBe("no-keys")
    expect(keys.keyring).toBeNull()
    // The structure is public; the content is not.
    expect(keys.timeline).toHaveLength(1)
  })
})

/* ---- reading ------------------------------------------------------------- */

describe("reading a notebook's keys", () => {
  it("reports none without an owner, rather than guessing", async () => {
    const { doc, owner } = await founded()

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      owner: null,
      now: T0,
    })

    expect(keys.access).toBe("none")
    expect(keys.keyring).toBeNull()
  })

  /** A timeline with a hole is refused whole; deriving against it is the risk. */
  it("refuses a timeline with a missing epoch and derives nothing", async () => {
    const { doc, owner } = await founded()

    // Epoch 3 with no epoch 2 behind it.
    putEpochRecord(
      doc,
      await signEpochRecord(
        { v: 1, domain: DOMAIN, epoch: 3, kind: "chain", reason: "member-added", createdAt: T0 + 2 },
        owner.signingKey,
        owner.did,
      ),
    )

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      owner: owner.did,
      now: T0,
    })

    expect(keys.access).toBe("untrusted-timeline")
    expect(keys.keyring).toBeNull()
  })

  it("drops an epoch record filed under the wrong epoch", async () => {
    const { doc, owner } = await founded()
    const signed = await signEpochRecord(genesisEpoch(DOMAIN, T0), owner.signingKey, owner.did)
    doc.getMap("workspace:epochs").set("99", signed)

    expect(storedEpochRecords(doc, DOMAIN)).toHaveLength(1)
  })

  it("ignores sealed keys belonging to another notebook", async () => {
    const { doc } = await founded()
    const other = storedSealedKeys(doc, DOMAIN)[0]
    putSealedKeys(doc, [{ ...other, domain: "notebook:elsewhere" }])

    expect(storedSealedKeys(doc, DOMAIN)).toHaveLength(1)
  })
})

/* ---- the writer's view --------------------------------------------------- */

describe("restoring the writer's view", () => {
  /** Possession of a sealing key is what makes it possible, not a saved blob. */
  it("rebuilds an admin able to cut the next epoch", async () => {
    const { doc, owner } = await founded()
    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      owner: owner.did,
      now: T0,
    })

    const admin = await restoreDomainAdmin(keys)
    expect(admin?.currentEpoch).toBe(1)

    const joiner = await aDevice()
    const cut = await admin!.addMember(
      { sealingDid: joiner.record.sealingDid },
      { createdAt: T0 + 1 },
    )

    expect(cut.record.epoch).toBe(2)
    expect(cut.record.kind).toBe("chain")
    expect(cut.sealed[0].recipient).toBe(joiner.record.sealingDid)
  })

  it("returns nothing for a device that holds no keys", async () => {
    const { doc, owner } = await founded()
    const stranger = await aDevice()
    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: stranger,
      owner: owner.did,
      now: T0,
    })

    expect(await restoreDomainAdmin(keys)).toBeNull()
  })
})
