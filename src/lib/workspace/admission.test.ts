import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import {
  createDeviceRecord,
  didFromSigningKey,
  type DeviceIdentity,
} from "@/lib/identity"

import {
  admitFromRedemption,
  findOwnerRoot,
  invitationsInDoc,
  inviteToNotebook,
  pendingRedemptions,
  redeemIntoNotebook,
} from "./admission"
import { foundNotebookKeys, readNotebookKeys } from "./notebook-keys"
import {
  foundNotebookWorkspace,
  readNotebookWorkspace,
  resourceIdFor,
} from "./notebook-workspace"

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const NOTEBOOK = "travel"

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

async function aNotebook(): Promise<{ doc: Y.Doc; owner: DeviceIdentity }> {
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

/** Owner invites, joiner redeems. The state just before a grant. */
async function upToRedemption(options: { now?: number } = {}) {
  const { doc, owner } = await aNotebook()
  const joiner = await aDevice()
  const { secret } = generateInvitationSecret()

  const invitation = await inviteToNotebook({
    doc,
    notebookId: NOTEBOOK,
    admin: owner,
    secret,
    label: "Ada Lovelace",
    now: T0,
  })
  const redemption = await redeemIntoNotebook({
    doc,
    secret,
    device: joiner,
    now: options.now ?? T0 + 1000,
  })
  return { doc, owner, joiner, invitation, redemption, secret }
}

/* ---- inviting ------------------------------------------------------------ */

describe("inviting someone to a notebook", () => {
  it("publishes an invitation scoped to this notebook's workspace", async () => {
    const { doc, invitation } = await upToRedemption()

    expect(invitation.workspace).toBe(`workspace:${NOTEBOOK}`)
    expect(invitationsInDoc(doc)).toHaveLength(1)
  })

  /** The name comes from the admin's invitation, never from the invitee. */
  it("fixes the label at invitation time", async () => {
    const { invitation } = await upToRedemption()
    expect(invitation.label).toBe("Ada Lovelace")
  })
})

/* ---- redeeming ----------------------------------------------------------- */

describe("redeeming", () => {
  it("publishes the invitee's real keys alongside the proof", async () => {
    const { doc, joiner, redemption } = await upToRedemption()

    expect(redemption.did).toBe(joiner.did)
    expect(doc.getMap("directory:devices").has(joiner.did)).toBe(true)
    expect(pendingRedemptions(doc)).toHaveLength(1)
  })

  /** Redeeming is not joining: nothing is granted until the owner grants it. */
  it("does not make the joiner a member", async () => {
    const { doc, owner, joiner } = await upToRedemption()

    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      now: T0 + 1000,
    })

    expect(workspace.directory?.devices.map((device) => device.record.did)).toEqual([owner.did])
    expect(workspace.users).toHaveLength(1)
    expect(joiner.did).not.toBe(owner.did)
  })
})

/* ---- granting ------------------------------------------------------------ */

describe("granting membership", () => {
  it("writes identity, keys and authority together", async () => {
    const { doc, owner, joiner, invitation, redemption } = await upToRedemption()

    const admission = await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      ability: "write",
      now: T0 + 2000,
    })

    expect(admission.epoch).toBe(2)

    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      now: T0 + 2000,
    })
    expect(workspace.directory?.devices).toHaveLength(2)
    expect(workspace.users).toHaveLength(2)

    // And the joiner can actually read.
    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: joiner,
      owner: owner.did,
      now: T0 + 2000,
    })
    expect(keys.access).toBe("reader")
    expect(keys.readableEpochs).toEqual([2])
  })

  /**
   * History is excluded by default: the chain runs forward, so the epoch the
   * joiner is sealed to cannot reach anything before it.
   */
  it("gives the joiner the new epoch and nothing earlier", async () => {
    const { doc, owner, joiner, invitation, redemption } = await upToRedemption()
    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      now: T0 + 2000,
    })

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: joiner,
      owner: owner.did,
      now: T0 + 2000,
    })
    expect(keys.readableEpochs).not.toContain(1)
    expect(await keys.keyring?.keyFor(1)).toBeUndefined()
  })

  /** The owner derives the new key rather than needing a sealed copy of it. */
  it("leaves the owner able to read both epochs", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()
    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      now: T0 + 2000,
    })

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: owner,
      owner: owner.did,
      now: T0 + 2000,
    })
    expect(keys.readableEpochs).toEqual([1, 2])
  })

  it("issues a non-delegable capability attenuated from the owner's root", async () => {
    const { doc, owner, joiner, invitation, redemption } = await upToRedemption()
    const root = await findOwnerRoot(doc, owner.did, resourceIdFor(NOTEBOOK), T0)

    const admission = await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      ability: "write",
      now: T0 + 2000,
    })

    expect(admission.capability.payload.aud).toBe(joiner.did)
    expect(admission.capability.payload.prf).toBe(root?.cid)
    expect(admission.capability.payload.can).toBe("write")
    // Zero depth: a member cannot pass their access on.
    expect(admission.capability.payload.dep).toBe(0)
  })

  it("never outlives the root it rests on", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()
    const root = await findOwnerRoot(doc, owner.did, resourceIdFor(NOTEBOOK), T0)

    const admission = await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      ttlMs: 1000 * DAY * 365,
      now: T0 + 2000,
    })

    expect(admission.capability.payload.exp).toBeLessThanOrEqual(root!.payload.exp)
  })

  it("refuses an expired invitation", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()

    await expect(
      admitFromRedemption({
        doc,
        notebookId: NOTEBOOK,
        owner,
        invitation,
        redemption,
        now: T0 + 30 * DAY,
      }),
    ).rejects.toThrow(/invalid, expired/)
  })

  /** Single use, enforced against what is already in the directory. */
  it("refuses a second device redeeming the same invitation", async () => {
    const { doc, owner, invitation, secret } = await upToRedemption()
    const interloper = await aDevice()
    const second = await redeemIntoNotebook({
      doc,
      secret,
      device: interloper,
      now: T0 + 1500,
    })

    await expect(
      admitFromRedemption({
        doc,
        notebookId: NOTEBOOK,
        owner,
        invitation,
        redemption: second,
        now: T0 + 2000,
      }),
    ).rejects.toThrow(/already redeemed/)
  })

  /** A failed grant must leave the document exactly as it was. */
  it("writes nothing when it refuses", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()
    const before = doc.getMap("directory:admissions").size
    const epochsBefore = doc.getMap("workspace:epochs").size

    await expect(
      admitFromRedemption({
        doc,
        notebookId: NOTEBOOK,
        owner,
        invitation,
        redemption,
        now: T0 + 30 * DAY,
      }),
    ).rejects.toThrow()

    expect(doc.getMap("directory:admissions").size).toBe(before)
    expect(doc.getMap("workspace:epochs").size).toBe(epochsBefore)
  })

  it("refuses when the granting device cannot open the current key", async () => {
    const { doc, invitation, redemption } = await upToRedemption()
    const impostor = await aDevice()

    await expect(
      admitFromRedemption({
        doc,
        notebookId: NOTEBOOK,
        owner: impostor,
        invitation,
        redemption,
        now: T0 + 2000,
      }),
    ).rejects.toThrow(/no valid root capability/)
  })

  it("clears the pending queue once granted", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()
    expect(pendingRedemptions(doc)).toHaveLength(1)

    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      now: T0 + 2000,
    })

    expect(pendingRedemptions(doc)).toHaveLength(0)
  })
})

/* ---- a second member ----------------------------------------------------- */

describe("a third person", () => {
  it("gets their own epoch, and cannot read the second member's earlier one", async () => {
    const { doc, owner, invitation, redemption } = await upToRedemption()
    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption,
      now: T0 + 2000,
    })

    const third = await aDevice()
    const { secret: secret3 } = generateInvitationSecret()
    const invite3 = await inviteToNotebook({
      doc,
      notebookId: NOTEBOOK,
      admin: owner,
      secret: secret3,
      label: "Grace",
      now: T0 + 3000,
    })
    const redeem3 = await redeemIntoNotebook({
      doc,
      secret: secret3,
      device: third,
      now: T0 + 3500,
    })
    const admission = await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation: invite3,
      redemption: redeem3,
      now: T0 + 4000,
    })

    expect(admission.epoch).toBe(3)

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: third,
      owner: owner.did,
      now: T0 + 4000,
    })
    expect(keys.readableEpochs).toEqual([3])

    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      now: T0 + 4000,
    })
    expect(workspace.users).toHaveLength(3)
  })
})
