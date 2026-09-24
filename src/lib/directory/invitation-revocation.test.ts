import { describe, expect, it } from "vitest"

import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"

import {
  createInvitation,
  generateInvitationSecret,
  type Invitation,
} from "./invitation"
import {
  revokedInvitationIds,
  revokeInvitation,
  verifyInvitationRevocation,
} from "./invitation-revocation"

const T0 = 1_700_000_000_000
const WORKSPACE = "workspace:travel"

interface Admin {
  key: SigningKey
  did: string
}

async function admin(): Promise<Admin> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

async function anInvitation(by: Admin): Promise<Invitation> {
  const { secret } = generateInvitationSecret()
  return createInvitation({
    adminSigningKey: by.key,
    adminDid: by.did,
    secret,
    member: "member:ada",
    label: "Ada",
    workspace: WORKSPACE,
    issuedAt: T0,
  })
}

describe("withdrawing an invitation", () => {
  it("verifies from a trusted admin", async () => {
    const owner = await admin()
    const invitation = await anInvitation(owner)
    const revocation = await revokeInvitation({
      signingKey: owner.key,
      admin: owner.did,
      invitation,
      revokedAt: T0 + 1,
    })

    expect(await verifyInvitationRevocation(revocation, invitation, [owner.did])).toBe(true)
  })

  /** Otherwise anyone could withdraw anyone's invitation - a cheap denial of joining. */
  it("refuses one from someone who is not an admin", async () => {
    const owner = await admin()
    const stranger = await admin()
    const invitation = await anInvitation(owner)
    const revocation = await revokeInvitation({
      signingKey: stranger.key,
      admin: stranger.did,
      invitation,
      revokedAt: T0 + 1,
    })

    expect(await verifyInvitationRevocation(revocation, invitation, [owner.did])).toBe(false)
  })

  /** Being able to take access back is what admin means. */
  it("accepts one from a different admin than the issuer", async () => {
    const issuer = await admin()
    const other = await admin()
    const invitation = await anInvitation(issuer)
    const revocation = await revokeInvitation({
      signingKey: other.key,
      admin: other.did,
      invitation,
      revokedAt: T0 + 1,
    })

    expect(
      await verifyInvitationRevocation(revocation, invitation, [issuer.did, other.did]),
    ).toBe(true)
  })

  it("refuses one pointed at a different invitation", async () => {
    const owner = await admin()
    const first = await anInvitation(owner)
    const second = await anInvitation(owner)
    const revocation = await revokeInvitation({
      signingKey: owner.key,
      admin: owner.did,
      invitation: first,
      revokedAt: T0 + 1,
    })

    expect(await verifyInvitationRevocation(revocation, second, [owner.did])).toBe(false)
  })

  it("refuses a tampered record", async () => {
    const owner = await admin()
    const invitation = await anInvitation(owner)
    const revocation = await revokeInvitation({
      signingKey: owner.key,
      admin: owner.did,
      invitation,
      revokedAt: T0 + 1,
    })

    expect(
      await verifyInvitationRevocation(
        { ...revocation, revokedAt: T0 + 999 },
        invitation,
        [owner.did],
      ),
    ).toBe(false)
  })

  it("collects only the ids that verify", async () => {
    const owner = await admin()
    const stranger = await admin()
    const withdrawn = await anInvitation(owner)
    const kept = await anInvitation(owner)

    const ids = await revokedInvitationIds(
      [
        await revokeInvitation({
          signingKey: owner.key,
          admin: owner.did,
          invitation: withdrawn,
          revokedAt: T0 + 1,
        }),
        await revokeInvitation({
          signingKey: stranger.key,
          admin: stranger.did,
          invitation: kept,
          revokedAt: T0 + 1,
        }),
      ],
      [withdrawn, kept],
      [owner.did],
    )

    expect([...ids]).toEqual([withdrawn.invitationId])
  })
})
