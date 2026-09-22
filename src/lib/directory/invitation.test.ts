import { describe, expect, it } from "vitest"
import { toHex } from "@/lib/crypto"
import { verifyAdmittedDevice } from "@/lib/identity"
import { newAdmin, newDevice, WORKSPACE } from "@/test/identity-fixtures"
import {
  createInvitation,
  deriveInvitationKey,
  formatInvitationSecret,
  generateInvitationSecret,
  grantFromRedemption,
  INVITATION_SECRET_BYTES,
  invitationIdFromSecret,
  isInvitationExpired,
  parseInvitationSecret,
  redeemInvitation,
  verifyInvitation,
  verifyRedemption,
  type Invitation,
  type Redemption,
} from "./invitation"

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

async function invite(
  admin: Awaited<ReturnType<typeof newAdmin>>,
  overrides: { member?: string; label?: string; workspace?: string; ttlMs?: number } = {},
) {
  const { secret } = generateInvitationSecret()
  const invitation = await createInvitation({
    adminSigningKey: admin.key,
    adminDid: admin.did,
    secret,
    member: overrides.member ?? "member:newcomer",
    label: overrides.label ?? "Newcomer",
    workspace: overrides.workspace ?? WORKSPACE,
    issuedAt: T0,
    ttlMs: overrides.ttlMs ?? 24 * HOUR,
  })
  return { secret, invitation }
}

describe("the invitation secret", () => {
  it("is 128 bits and round-trips through its human format", () => {
    const { secret, text } = generateInvitationSecret()
    expect(secret).toHaveLength(INVITATION_SECRET_BYTES)
    expect(toHex(parseInvitationSecret(text))).toBe(toHex(secret))
  })

  // Humans retype these out of chat messages, so parsing has to be forgiving
  // about the things humans change without meaning to.
  it("tolerates case, spacing and regrouping", () => {
    const { secret, text } = generateInvitationSecret()
    const mangled = text.toLowerCase().replace(/-/g, " ")
    expect(toHex(parseInvitationSecret(mangled))).toBe(toHex(secret))
    expect(toHex(parseInvitationSecret(text.replace(/-/g, "")))).toBe(toHex(secret))
  })

  it("is grouped for legibility", () => {
    const { text } = generateInvitationSecret()
    expect(text).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/)
  })

  it("rejects malformed input", () => {
    expect(() => parseInvitationSecret("")).toThrow(/empty/)
    expect(() => parseInvitationSecret("!!!!")).toThrow(/not valid base32/)
    expect(() => parseInvitationSecret("ABCDE")).toThrow(/16 bytes/)
  })

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateInvitationSecret().text))
    expect(seen.size).toBe(20)
  })
})

describe("derivation", () => {
  it("both sides derive the same key from the same secret", async () => {
    const { secret } = generateInvitationSecret()
    const admin = await deriveInvitationKey(secret)
    const invitee = await deriveInvitationKey(secret)
    expect(toHex(admin.publicKey)).toBe(toHex(invitee.publicKey))
  })

  it("different secrets derive different keys", async () => {
    const a = await deriveInvitationKey(generateInvitationSecret().secret)
    const b = await deriveInvitationKey(generateInvitationSecret().secret)
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey))
  })

  it("the invitation id is the derived public key", async () => {
    const { secret } = generateInvitationSecret()
    expect(await invitationIdFromSecret(secret)).toMatch(/^did:key:z6Mk/)
  })
})

describe("createInvitation", () => {
  it("names the member and label the admin chose", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)

    expect(invitation.invitationId).toBe(await invitationIdFromSecret(secret))
    expect(invitation.member).toBe("member:newcomer")
    expect(invitation.label).toBe("Newcomer")
    expect(invitation.admin).toBe(admin.did)
    expect(await verifyInvitation(invitation, [admin.did], { now: T0 })).toBe(true)
  })

  it("requires a member and a label", async () => {
    const admin = await newAdmin()
    const { secret } = generateInvitationSecret()
    const base = {
      adminSigningKey: admin.key,
      adminDid: admin.did,
      secret,
      workspace: WORKSPACE,
    }
    await expect(createInvitation({ ...base, member: " ", label: "x" })).rejects.toThrow(
      /must name a member/,
    )
    await expect(createInvitation({ ...base, member: "m", label: " " })).rejects.toThrow(
      /non-empty human label/,
    )
  })

  it("refuses when the named admin is not the signing key", async () => {
    const admin = await newAdmin()
    const other = await newAdmin()
    await expect(
      createInvitation({
        adminSigningKey: admin.key,
        adminDid: other.did,
        secret: generateInvitationSecret().secret,
        member: "m",
        label: "L",
        workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/does not match the supplied admin signing key/)
  })
})

describe("verifyInvitation", () => {
  it("rejects an untrusted issuer, wrong workspace, and tampering", async () => {
    const admin = await newAdmin()
    const rogue = await newAdmin()
    const { invitation } = await invite(admin)

    expect(await verifyInvitation(invitation, [rogue.did], { now: T0 })).toBe(false)
    expect(
      await verifyInvitation(invitation, [admin.did], { now: T0, workspace: "workspace:other" }),
    ).toBe(false)
    expect(
      await verifyInvitation({ ...invitation, label: "Someone Else" }, [admin.did], { now: T0 }),
    ).toBe(false)
    expect(
      await verifyInvitation({ ...invitation, member: "member:other" }, [admin.did], { now: T0 }),
    ).toBe(false)
    expect(
      await verifyInvitation({ ...invitation, expiresAt: T0 + 999 * HOUR }, [admin.did], {
        now: T0,
      }),
    ).toBe(false)
  })

  it("expires", async () => {
    const admin = await newAdmin()
    const { invitation } = await invite(admin, { ttlMs: HOUR })

    expect(await verifyInvitation(invitation, [admin.did], { now: T0 })).toBe(true)
    expect(await verifyInvitation(invitation, [admin.did], { now: T0 + HOUR })).toBe(false)
    expect(isInvitationExpired(invitation, T0 + HOUR)).toBe(true)
    expect(isInvitationExpired(invitation, T0)).toBe(false)
  })

  it("returns false rather than throwing on malformed input", async () => {
    const admin = await newAdmin()
    const { invitation } = await invite(admin)
    expect(
      await verifyInvitation({ ...invitation, invitationId: "nope" }, [admin.did], { now: T0 }),
    ).toBe(false)
    expect(await verifyInvitation({} as Invitation, [admin.did], { now: T0 })).toBe(false)
  })
})

describe("redemption binds the invitee's real keys", () => {
  it("verifies against the invitation", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)
    const invitee = await newDevice()

    const redemption = await redeemInvitation({
      secret,
      record: invitee.record,
      redeemedAt: T0 + HOUR,
    })
    expect(redemption.did).toBe(invitee.record.did)
    expect(await verifyRedemption(redemption, invitation, { now: T0 + HOUR })).toBe(true)
  })

  // The property that removes trust-on-first-use: an attacker who sees the
  // redemption in transit cannot swap in their own device record, because the
  // signature is under a key only the secret holder can derive.
  it("cannot be rebound to an attacker's device record", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)
    const invitee = await newDevice()
    const attacker = await newDevice()

    const honest = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })

    // Swap the record but keep the signature: fields no longer agree.
    const swappedRecord: Redemption = { ...honest, record: attacker.record }
    expect(await verifyRedemption(swappedRecord, invitation, { now: T0 })).toBe(false)

    // Swap the bound fields too: the signature no longer covers them.
    const swappedAll: Redemption = {
      ...honest,
      record: attacker.record,
      did: attacker.record.did,
      sealingDid: attacker.record.sealingDid,
      clientId: attacker.record.clientId,
    }
    expect(await verifyRedemption(swappedAll, invitation, { now: T0 })).toBe(false)
  })

  it("cannot be forged without the secret", async () => {
    const admin = await newAdmin()
    const { invitation } = await invite(admin)
    const attacker = await newDevice()

    // The attacker has the published invitation but a different secret.
    const forged = await redeemInvitation({
      secret: generateInvitationSecret().secret,
      record: attacker.record,
      redeemedAt: T0,
    })
    expect(await verifyRedemption({ ...forged, invitationId: invitation.invitationId }, invitation, {
      now: T0,
    })).toBe(false)
  })

  it("rejects a redemption for a different invitation", async () => {
    const admin = await newAdmin()
    const first = await invite(admin)
    const second = await invite(admin)
    const invitee = await newDevice()

    const redemption = await redeemInvitation({
      secret: first.secret,
      record: invitee.record,
      redeemedAt: T0,
    })
    expect(await verifyRedemption(redemption, second.invitation, { now: T0 })).toBe(false)
  })

  it("refuses to redeem with an unverifiable record", async () => {
    const { secret } = generateInvitationSecret()
    const invitee = await newDevice()
    await expect(
      redeemInvitation({
        secret,
        record: { ...invitee.record, clientId: invitee.record.clientId + 1 },
      }),
    ).rejects.toThrow(/does not verify/)
  })

  it("rejects redemption after expiry", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin, { ttlMs: HOUR })
    const invitee = await newDevice()

    const late = await redeemInvitation({
      secret,
      record: invitee.record,
      redeemedAt: T0 + 2 * HOUR,
    })
    expect(await verifyRedemption(late, invitation, { now: T0 + 2 * HOUR })).toBe(false)

    // Redeemed in time, but presented after expiry - still refused.
    const inTime = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })
    expect(await verifyRedemption(inTime, invitation, { now: T0 + 2 * HOUR })).toBe(false)
  })
})

describe("the admin-gated grant", () => {
  // The M3 exit criterion, end to end.
  it("admits a brand-new device with no trust-on-first-use", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)
    const invitee = await newDevice()

    const redemption = await redeemInvitation({
      secret,
      record: invitee.record,
      redeemedAt: T0 + HOUR,
    })
    const admission = await grantFromRedemption({
      adminSigningKey: admin.key,
      adminDid: admin.did,
      invitation,
      redemption,
      trustedAdminDids: [admin.did],
      now: T0 + 2 * HOUR,
    })

    expect(await verifyAdmittedDevice({ record: invitee.record, admission }, [admin.did])).toBe(
      true,
    )
    // Identity and name come from the admin's invitation, never the invitee.
    expect(admission.member).toBe("member:newcomer")
    expect(admission.label).toBe("Newcomer")
  })

  it("refuses an invitation from an untrusted admin", async () => {
    const admin = await newAdmin()
    const rogue = await newAdmin()
    const { secret, invitation } = await invite(rogue)
    const invitee = await newDevice()
    const redemption = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })

    await expect(
      grantFromRedemption({
        adminSigningKey: admin.key,
        adminDid: admin.did,
        invitation,
        redemption,
        trustedAdminDids: [admin.did],
        now: T0,
      }),
    ).rejects.toThrow(/not from a trusted admin/)
  })

  it("refuses an expired invitation", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin, { ttlMs: HOUR })
    const invitee = await newDevice()
    const redemption = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })

    await expect(
      grantFromRedemption({
        adminSigningKey: admin.key,
        adminDid: admin.did,
        invitation,
        redemption,
        trustedAdminDids: [admin.did],
        now: T0 + 2 * HOUR,
      }),
    ).rejects.toThrow(/expired/)
  })

  it("is single-use: a second device cannot redeem the same invitation", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)
    const first = await newDevice()
    const second = await newDevice()

    const firstRedemption = await redeemInvitation({
      secret,
      record: first.record,
      redeemedAt: T0,
    })
    const secondRedemption = await redeemInvitation({
      secret,
      record: second.record,
      redeemedAt: T0 + HOUR,
    })

    await expect(
      grantFromRedemption({
        adminSigningKey: admin.key,
        adminDid: admin.did,
        invitation,
        redemption: secondRedemption,
        trustedAdminDids: [admin.did],
        priorRedemptions: [firstRedemption],
        now: T0 + HOUR,
      }),
    ).rejects.toThrow(/already redeemed by a different device/)
  })

  // Re-granting the same device is a retry, not a reuse.
  it("is idempotent for the same device", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin)
    const invitee = await newDevice()
    const redemption = await redeemInvitation({ secret, record: invitee.record, redeemedAt: T0 })

    const admission = await grantFromRedemption({
      adminSigningKey: admin.key,
      adminDid: admin.did,
      invitation,
      redemption,
      trustedAdminDids: [admin.did],
      priorRedemptions: [redemption],
      now: T0,
    })
    expect(admission.did).toBe(invitee.record.did)
    expect(admission.member).toBe(invitation.member)
  })

  it("refuses a redemption that does not match the invitation", async () => {
    const admin = await newAdmin()
    const target = await invite(admin)
    const other = await invite(admin)
    const invitee = await newDevice()
    const redemption = await redeemInvitation({
      secret: other.secret,
      record: invitee.record,
      redeemedAt: T0,
    })

    await expect(
      grantFromRedemption({
        adminSigningKey: admin.key,
        adminDid: admin.did,
        invitation: target.invitation,
        redemption,
        trustedAdminDids: [admin.did],
        now: T0,
      }),
    ).rejects.toThrow(/does not verify against this invitation/)
  })
})

describe("asynchrony", () => {
  // Neither party needs the other online: each step consumes only records.
  it("completes with each step separated in time", async () => {
    const admin = await newAdmin()
    const { secret, invitation } = await invite(admin, { ttlMs: 72 * HOUR })

    // Hours later, the invitee redeems with no admin present.
    const invitee = await newDevice()
    const redemption = await redeemInvitation({
      secret,
      record: invitee.record,
      redeemedAt: T0 + 20 * HOUR,
    })

    // Hours later again, an admin grants with no invitee present.
    const admission = await grantFromRedemption({
      adminSigningKey: admin.key,
      adminDid: admin.did,
      invitation,
      redemption,
      trustedAdminDids: [admin.did],
      now: T0 + 40 * HOUR,
    })

    expect(await verifyAdmittedDevice({ record: invitee.record, admission }, [admin.did])).toBe(
      true,
    )
  })
})

describe("formatInvitationSecret", () => {
  it("is stable for a given secret", () => {
    const { secret } = generateInvitationSecret()
    expect(formatInvitationSecret(secret)).toBe(formatInvitationSecret(secret))
  })
})
