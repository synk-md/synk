import { describe, expect, it } from "vitest"
import { toBase64Url } from "@/lib/crypto"
import { asAdmitted, asLinked, admitDevice, linkDevice, newAdmin } from "@/test/identity-fixtures"
import type { MemberDevice } from "@/lib/identity"
import {
  revokeLink,
  revokedLinkDids,
  verifyLinkRevocation,
  withoutRevokedLinks,
  type LinkRevocation,
} from "./link-revocation"

const T0 = 1_700_000_000_000

/** A member with one admin-admitted laptop and one self-linked phone. */
async function memberWithPhone() {
  const admin = await newAdmin()
  const laptop = await admitDevice(admin, { member: "member:maren", label: "Maren" })
  const phone = await linkDevice(laptop)
  const devices: MemberDevice[] = [asAdmitted(laptop), asLinked(phone)]
  return { admin, laptop, phone, devices }
}

describe("a member can invalidate their own linked device", () => {
  // The gap M2 left: a lost linked device stayed valid until the member's whole
  // admission was withdrawn.
  it("revokes from another device of the same member, with no admin", async () => {
    const { laptop, phone, devices } = await memberWithPhone()

    const revocation = await revokeLink({
      signingKey: laptop.key,
      revoker: laptop.record.did,
      link: phone.link,
      reason: "lost on a train",
      revokedAt: T0,
    })

    expect(revocation.did).toBe(phone.record.did)
    expect(revocation.member).toBe(phone.link.member)
    expect(await verifyLinkRevocation(revocation, phone.link, devices)).toBe(true)
  })

  it("drops the revoked device from the member's set", async () => {
    const { laptop, phone, devices } = await memberWithPhone()
    const revocation = await revokeLink({
      signingKey: laptop.key,
      revoker: laptop.record.did,
      link: phone.link,
      revokedAt: T0,
    })

    expect(await revokedLinkDids([revocation], devices)).toEqual(new Set([phone.record.did]))
    const remaining = await withoutRevokedLinks(devices, [revocation])
    expect(remaining.map((d) => d.record.did)).toEqual([laptop.record.did])
  })

  it("leaves other devices alone", async () => {
    const { laptop, phone, devices } = await memberWithPhone()
    const tablet = await linkDevice(laptop)
    const all = [...devices, asLinked(tablet)]

    const revocation = await revokeLink({
      signingKey: laptop.key,
      revoker: laptop.record.did,
      link: phone.link,
      revokedAt: T0,
    })
    const remaining = await withoutRevokedLinks(all, [revocation])
    expect(remaining.map((d) => d.record.did).sort()).toEqual(
      [laptop.record.did, tablet.record.did].sort(),
    )
  })
})

describe("entitlement", () => {
  // Anyone can sign a revocation naming any device; only the member's own
  // admin-admitted devices may actually unlink one.
  it("refuses a revocation from a stranger", async () => {
    const { phone, devices } = await memberWithPhone()
    const otherAdmin = await newAdmin()
    const stranger = await admitDevice(otherAdmin, { member: "member:mallory", label: "Mallory" })

    const forged = await revokeLink({
      signingKey: stranger.key,
      revoker: stranger.record.did,
      link: phone.link,
      revokedAt: T0,
    })
    expect(await verifyLinkRevocation(forged, phone.link, devices)).toBe(false)
  })

  // A linked device cannot unlink itself or its siblings - only an
  // admin-admitted device of the member can.
  it("refuses a revocation from another linked device", async () => {
    const { laptop, phone, devices } = await memberWithPhone()
    const tablet = await linkDevice(laptop)
    const all = [...devices, asLinked(tablet)]

    const byTablet = await revokeLink({
      signingKey: tablet.key,
      revoker: tablet.record.did,
      link: phone.link,
      revokedAt: T0,
    })
    expect(await verifyLinkRevocation(byTablet, phone.link, all)).toBe(false)
  })

  it("refuses a device revoking itself", async () => {
    const { phone } = await memberWithPhone()
    await expect(
      revokeLink({
        signingKey: phone.key,
        revoker: phone.record.did,
        link: phone.link,
        revokedAt: T0,
      }),
    ).rejects.toThrow(/cannot revoke itself/)
  })

  it("refuses a revoker that did not sign", async () => {
    const { laptop, phone } = await memberWithPhone()
    const other = await newAdmin()
    const otherDevice = await admitDevice(other, { member: "member:x", label: "X" })
    await expect(
      revokeLink({
        signingKey: laptop.key,
        revoker: otherDevice.record.did,
        link: phone.link,
      }),
    ).rejects.toThrow(/does not match the supplied signing key/)
  })

  it("refuses a revocation retargeted to another device or member", async () => {
    const { laptop, phone, devices } = await memberWithPhone()
    const revocation = await revokeLink({
      signingKey: laptop.key,
      revoker: laptop.record.did,
      link: phone.link,
      revokedAt: T0,
    })

    for (const tampered of [
      { ...revocation, did: "did:key:z6MkSomeoneElse" },
      { ...revocation, member: "member:other" },
      { ...revocation, workspace: "workspace:other" },
      { ...revocation, sig: toBase64Url(new Uint8Array(64)) },
    ] as LinkRevocation[]) {
      expect(await verifyLinkRevocation(tampered, phone.link, devices)).toBe(false)
    }
  })

  it("returns false rather than throwing on nonsense", async () => {
    const { phone, devices } = await memberWithPhone()
    expect(await verifyLinkRevocation({} as LinkRevocation, phone.link, devices)).toBe(false)
    expect(
      await verifyLinkRevocation({ v: 2 } as unknown as LinkRevocation, phone.link, devices),
    ).toBe(false)
  })
})
