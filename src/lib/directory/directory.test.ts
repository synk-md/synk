import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateSealingKey } from "@/lib/crypto"
import { didFromSealingKey } from "@/lib/identity"
import {
  admitDevice,
  linkDevice,
  newAdmin,
  newDevice,
  WORKSPACE,
} from "@/test/identity-fixtures"
import {
  DIRECTORY_MAPS,
  putAdmission,
  putDeviceRecord,
  putInvitation,
  putLink,
  putPrekeyBundle,
  putRedemption,
  rawEntries,
  readDirectory,
  redemptionsFor,
  sealingBundleFor,
} from "./directory"
import { publishPrekeys } from "./prekeys"
import {
  createInvitation,
  generateInvitationSecret,
  grantFromRedemption,
  redeemInvitation,
} from "./invitation"

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

/** Publish an admin-admitted device into the directory. */
async function publishAdmitted(doc: Y.Doc, admin: Awaited<ReturnType<typeof newAdmin>>) {
  const device = await admitDevice(admin)
  putDeviceRecord(doc, device.record)
  putAdmission(doc, device.admission)
  return device
}

describe("readDirectory", () => {
  it("returns devices present by admission and by link", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const laptop = await publishAdmitted(doc, admin)
    const phone = await linkDevice(laptop)
    putDeviceRecord(doc, phone.record)
    putLink(doc, phone.link)

    const directory = await readDirectory(doc, [admin.did], { now: T0 })

    expect(directory.devices).toHaveLength(2)
    expect(directory.rejected).toBe(0)
    expect(directory.devices.map((d) => d.kind).sort()).toEqual(["admitted", "linked"])
  })

  it("is empty for an empty document", async () => {
    const directory = await readDirectory(new Y.Doc(), [], { now: T0 })
    expect(directory.devices).toEqual([])
    expect(directory.rejected).toBe(0)
  })
})

// The property the whole module rests on: Yjs is the transport, never the
// authority. Anything a peer can write, a reader re-verifies and may drop.
describe("the merge is never trusted", () => {
  it("drops a device record whose signature does not verify", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const device = await publishAdmitted(doc, admin)

    // A hostile peer overwrites the record in place.
    doc
      .getMap(DIRECTORY_MAPS.devices)
      .set(device.record.did, { ...device.record, createdAt: device.record.createdAt + 1 })

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.devices).toHaveLength(0)
    expect(directory.rejected).toBeGreaterThan(0)
  })

  it("drops an admission from an admin outside the trusted set", async () => {
    const doc = new Y.Doc()
    const real = await newAdmin()
    const rogue = await newAdmin()
    await publishAdmitted(doc, rogue)

    expect((await readDirectory(doc, [real.did], { now: T0 })).devices).toHaveLength(0)
    expect((await readDirectory(doc, [rogue.did], { now: T0 })).devices).toHaveLength(1)
  })

  // The key a record is filed under is part of what is being asserted.
  it("drops a record misfiled under another DID", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const device = await admitDevice(admin)
    const other = await newDevice()

    doc.getMap(DIRECTORY_MAPS.devices).set(other.record.did, device.record)
    putAdmission(doc, device.admission)

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.devices).toHaveLength(0)
    expect(directory.rejected).toBeGreaterThan(0)
  })

  it("drops a link whose parent is not an admitted device in this directory", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)

    // The linked device is published, but its parent never was.
    putDeviceRecord(doc, phone.record)
    putLink(doc, phone.link)

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.devices).toHaveLength(0)
    expect(directory.rejected).toBeGreaterThan(0)
  })

  it("drops outright garbage without throwing", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    await publishAdmitted(doc, admin)

    doc.getMap(DIRECTORY_MAPS.devices).set("did:key:zJunk", { nonsense: true })
    doc.getMap(DIRECTORY_MAPS.admissions).set("did:key:zJunk", null)
    doc.getMap(DIRECTORY_MAPS.links).set("x", 42)
    doc.getMap(DIRECTORY_MAPS.prekeys).set("y", "not an object")
    doc.getMap(DIRECTORY_MAPS.invitations).set("z", [])
    doc.getMap(DIRECTORY_MAPS.redemptions).set("w", "not an array")

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.devices).toHaveLength(1)
    expect(directory.rejected).toBe(6)
  })

  // Two replicas converging on hostile state must reach the same verified view.
  it("survives a real Yjs merge from a hostile peer", async () => {
    const honest = new Y.Doc()
    const hostile = new Y.Doc()
    const admin = await newAdmin()
    const device = await publishAdmitted(honest, admin)

    Y.applyUpdate(hostile, Y.encodeStateAsUpdate(honest))
    // The hostile replica forges an admission for a device it does not control.
    const attacker = await newDevice()
    putDeviceRecord(hostile, attacker.record)
    hostile
      .getMap(DIRECTORY_MAPS.admissions)
      .set(attacker.record.did, { ...device.admission, did: attacker.record.did })
    Y.applyUpdate(honest, Y.encodeStateAsUpdate(hostile))

    const directory = await readDirectory(honest, [admin.did], { now: T0 })
    expect(directory.devices).toHaveLength(1)
    expect(directory.devices[0].record.did).toBe(device.record.did)
    expect(directory.rejected).toBeGreaterThan(0)
  })
})

describe("prekeys in the directory", () => {
  it("returns a bundle for a present device", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const device = await publishAdmitted(doc, admin)

    const bundle = await publishPrekeys({
      signingKey: device.key,
      record: device.record,
      signedPrekey: didFromSealingKey((await generateSealingKey()).publicKey),
      publishedAt: T0,
    })
    putPrekeyBundle(doc, bundle)

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(sealingBundleFor(directory, device.record.did)?.signedPrekey).toBe(bundle.signedPrekey)
  })

  // Only devices actually present may publish a sealing target, or a stranger
  // could advertise where to send a member's keys.
  it("drops a bundle from a device that is not in the directory", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    await publishAdmitted(doc, admin)

    const stranger = await newDevice()
    putPrekeyBundle(
      doc,
      await publishPrekeys({
        signingKey: stranger.key,
        record: stranger.record,
        signedPrekey: didFromSealingKey((await generateSealingKey()).publicKey),
        publishedAt: T0,
      }),
    )

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.prekeys.has(stranger.record.did)).toBe(false)
    expect(directory.rejected).toBeGreaterThan(0)
  })

  it("drops an expired bundle", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const device = await publishAdmitted(doc, admin)

    const bundle = await publishPrekeys({
      signingKey: device.key,
      record: device.record,
      signedPrekey: didFromSealingKey((await generateSealingKey()).publicKey),
      publishedAt: T0,
      ttlMs: HOUR,
    })
    putPrekeyBundle(doc, bundle)

    expect((await readDirectory(doc, [admin.did], { now: T0 })).prekeys.size).toBe(1)
    expect((await readDirectory(doc, [admin.did], { now: T0 + 2 * HOUR })).prekeys.size).toBe(0)
  })
})

describe("invitations and redemptions in the directory", () => {
  async function seedInvitation(doc: Y.Doc, admin: Awaited<ReturnType<typeof newAdmin>>) {
    const { secret } = generateInvitationSecret()
    const invitation = await createInvitation({
      adminSigningKey: admin.key,
      adminDid: admin.did,
      secret,
      member: "member:newcomer",
      label: "Newcomer",
      workspace: WORKSPACE,
      issuedAt: T0,
      ttlMs: 24 * HOUR,
    })
    putInvitation(doc, invitation)
    return { secret, invitation }
  }

  it("carries a verified invitation", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const { invitation } = await seedInvitation(doc, admin)

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.invitations.map((i) => i.invitationId)).toEqual([invitation.invitationId])
  })

  it("drops an invitation from an untrusted admin, and an expired one", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const stranger = await newAdmin()
    await seedInvitation(doc, admin)

    expect((await readDirectory(doc, [stranger.did], { now: T0 })).invitations).toHaveLength(0)
    expect((await readDirectory(doc, [admin.did], { now: T0 + 48 * HOUR })).invitations).toHaveLength(
      0,
    )
  })

  // Overwriting would hide exactly what single-use enforcement needs to see.
  it("accumulates redemptions rather than overwriting them", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const { secret, invitation } = await seedInvitation(doc, admin)

    const first = await newDevice()
    const second = await newDevice()
    putRedemption(doc, await redeemInvitation({ secret, record: first.record, redeemedAt: T0 }))
    putRedemption(
      doc,
      await redeemInvitation({ secret, record: second.record, redeemedAt: T0 + HOUR }),
    )

    const recorded = await redemptionsFor(doc, invitation.invitationId, [admin.did], { now: T0 + HOUR })
    expect(recorded).toHaveLength(2)
    expect(recorded.map((r) => r.did).sort()).toEqual(
      [first.record.did, second.record.did].sort(),
    )
  })

  it("does not record the identical redemption twice", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const { secret, invitation } = await seedInvitation(doc, admin)
    const invitee = await newDevice()

    const redemption = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })
    putRedemption(doc, redemption)
    putRedemption(doc, redemption)

    expect(await redemptionsFor(doc, invitation.invitationId, [admin.did], { now: T0 })).toHaveLength(
      1,
    )
  })

  it("drops a redemption whose invitation is absent or invalid", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    const { secret } = generateInvitationSecret()
    const invitee = await newDevice()

    // Redemption published with no matching invitation record.
    putRedemption(doc, await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 }))

    const directory = await readDirectory(doc, [admin.did], { now: T0 })
    expect(directory.redemptions.size).toBe(0)
    expect(directory.rejected).toBeGreaterThan(0)
  })

  // The exit criterion, driven entirely through directory state.
  it("admits a new device end to end with neither party online together", async () => {
    const adminDoc = new Y.Doc()
    const inviteeDoc = new Y.Doc()
    const admin = await newAdmin()
    const { secret, invitation } = await seedInvitation(adminDoc, admin)

    // The invitee syncs, redeems offline, and publishes. No admin present.
    Y.applyUpdate(inviteeDoc, Y.encodeStateAsUpdate(adminDoc))
    const invitee = await newDevice()
    const redemption = await redeemInvitation({
      secret,
      record: invitee.record,
      redeemedAt: T0 + HOUR,
    })
    putDeviceRecord(inviteeDoc, invitee.record)
    putRedemption(inviteeDoc, redemption)

    // Later, the admin syncs and grants. No invitee present.
    Y.applyUpdate(adminDoc, Y.encodeStateAsUpdate(inviteeDoc))
    const prior = await redemptionsFor(adminDoc, invitation.invitationId, [admin.did], {
      now: T0 + 5 * HOUR,
    })
    const admission = await grantFromRedemption({
      adminSigningKey: admin.key,
      adminDid: admin.did,
      invitation,
      redemption: prior[0],
      trustedAdminDids: [admin.did],
      priorRedemptions: prior,
      now: T0 + 5 * HOUR,
    })
    putAdmission(adminDoc, admission)

    // The invitee syncs back and sees itself admitted.
    Y.applyUpdate(inviteeDoc, Y.encodeStateAsUpdate(adminDoc))
    const directory = await readDirectory(inviteeDoc, [admin.did], { now: T0 + 6 * HOUR })

    expect(directory.devices.map((d) => d.record.did)).toContain(invitee.record.did)
    const admitted = directory.devices.find((d) => d.record.did === invitee.record.did)
    expect(admitted?.kind).toBe("admitted")
  })
})

describe("rawEntries", () => {
  it("exposes unverified state for debugging", async () => {
    const doc = new Y.Doc()
    const admin = await newAdmin()
    await publishAdmitted(doc, admin)
    doc.getMap(DIRECTORY_MAPS.devices).set("did:key:zJunk", { nonsense: true })

    // Two raw entries, but only one survives verification.
    expect(rawEntries(doc, DIRECTORY_MAPS.devices)).toHaveLength(2)
    expect((await readDirectory(doc, [admin.did], { now: T0 })).devices).toHaveLength(1)
  })
})
