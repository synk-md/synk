import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deviceFingerprint } from "@/lib/identity"
import {
  createInvitation,
  generateInvitationSecret,
  redeemInvitation,
  type Invitation,
  type Redemption,
} from "@/lib/directory"
import { newAdmin, newDevice, WORKSPACE } from "@/test/identity-fixtures"
import { CreateInviteDialog } from "./create-invite-dialog"
import { ApproveRedemptionDialog } from "./approve-redemption-dialog"
import { PendingInvites } from "./pending-invites"
import { IdentityBadge } from "@/components/custom-ui/identity/identity-badge"

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const JOIN_LINK = "https://synk.example/join?ws=workspace%3Aacme"

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })
})
afterEach(cleanup)

async function anInvitation(
  overrides: { label?: string; ttlMs?: number; issuedAt?: number } = {},
): Promise<{ invitation: Invitation; secret: Uint8Array }> {
  const admin = await newAdmin()
  const { secret } = generateInvitationSecret()
  const invitation = await createInvitation({
    adminSigningKey: admin.key,
    adminDid: admin.did,
    secret,
    member: "member:ada",
    label: overrides.label ?? "Ada Lovelace",
    workspace: WORKSPACE,
    issuedAt: overrides.issuedAt ?? T0,
    ttlMs: overrides.ttlMs ?? 7 * DAY,
  })
  return { invitation, secret }
}

async function aRedemption(
  invitation: Invitation,
  secret: Uint8Array,
): Promise<{ redemption: Redemption; did: string }> {
  const invitee = await newDevice()
  const redemption = await redeemInvitation({
    secret,
    record: invitee.record,
    redeemedAt: T0 + DAY,
  })
  void invitation
  return { redemption, did: invitee.record.did }
}

describe("CreateInviteDialog", () => {
  function setup(onCreate = vi.fn()) {
    render(
      <CreateInviteDialog open onClose={vi.fn()} onCreate={onCreate} joinLink={JOIN_LINK} />,
    )
    return onCreate
  }

  async function reachShareStage() {
    const created = await anInvitation()
    const onCreate = vi.fn().mockResolvedValue(created.invitation)
    setup(onCreate)

    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Ada Lovelace" } })
    fireEvent.click(screen.getByRole("button", { name: /Create invitation/ }))
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Send these separately" })).toBeInTheDocument()
    })
    return onCreate
  }

  it("makes the admin name the person being vouched for", async () => {
    const onCreate = setup(vi.fn().mockResolvedValue((await anInvitation()).invitation))
    const create = screen.getByRole("button", { name: /Create invitation/ })

    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Ada Lovelace" } })
    expect(create).toBeEnabled()

    fireEvent.click(create)
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Ada Lovelace", member: "member:ada-lovelace" }),
      )
    })
  })

  /**
   * The property the whole screen exists for. The published invitation says who
   * was invited; the secret is the only thing proving you are them. If both
   * reach one inbox, whoever reads it can join as the invitee.
   */
  it("never puts the secret in the link", async () => {
    await reachShareStage()
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(JOIN_LINK)
    })
    const secret = screen.getByLabelText("One-time code").textContent ?? ""
    expect(secret.length).toBeGreaterThan(0)
    expect(JOIN_LINK).not.toContain(secret)
    expect(JOIN_LINK).not.toContain(secret.replace(/-/g, ""))
  })

  // A single "copy invitation" action would undo the separation, so there
  // isn't one. Asserted, because it is the sort of convenience that gets added.
  it("offers no combined copy action", async () => {
    await reachShareStage()
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "")
    expect(buttons.filter((text) => /copy/i.test(text))).toHaveLength(1)
    expect(buttons.some((text) => /copy (invite|invitation|both|all)/i.test(text))).toBe(false)
  })

  // Sequencing the reveal makes the natural order send, switch channel, send -
  // rather than select-all in one message.
  it("withholds the code until the link has been sent", async () => {
    await reachShareStage()

    expect(screen.queryByLabelText("One-time code")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Send the link first")

    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }))
    await waitFor(() => {
      expect(screen.getByLabelText("One-time code")).toBeInTheDocument()
    })
  })

  it("names concrete channels rather than saying 'use a secure channel'", async () => {
    await reachShareStage()
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent("different routes")
    expect(note.textContent).toMatch(/call|text|chat|email/i)
  })

  it("copies the code separately once revealed", async () => {
    await reachShareStage()
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }))
    await waitFor(() => screen.getByLabelText("One-time code"))

    const code = screen.getByLabelText("One-time code").textContent ?? ""
    fireEvent.click(screen.getByRole("button", { name: /Copy code/ }))
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith(code)
    })
  })

  it("surfaces a failure to create without losing what was typed", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("not an admin here"))
    setup(onCreate)
    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Ada" } })
    fireEvent.click(screen.getByRole("button", { name: /Create invitation/ }))

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("not an admin here")
    })
    expect(screen.getByLabelText("Their name")).toHaveValue("Ada")
  })
})

describe("ApproveRedemptionDialog", () => {
  async function setup(
    options: { ttlMs?: number; now?: number } = {},
  ) {
    const { invitation, secret } = await anInvitation(
      options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs },
    )
    const { redemption, did } = await aRedemption(invitation, secret)
    const onGrant = vi.fn()
    const onReject = vi.fn()
    const onClose = vi.fn()

    render(
      <ApproveRedemptionDialog
        open
        pending={{ invitation, redemption }}
        onGrant={onGrant}
        onReject={onReject}
        onClose={onClose}
        now={options.now ?? T0 + DAY}
      />,
    )
    return { invitation, redemption, did, onGrant, onReject, onClose }
  }

  /**
   * The trap: the name came from the admin's own invitation, so it looks
   * confirmed. It says who the admin *meant* to invite, not who turned up
   * holding the secret.
   */
  it("shows the invited name as unverified until the key is checked", async () => {
    await setup()

    // The name appears in the subject line and again in the explanation; the
    // badge sits beside the subject, which is what gets skimmed.
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0)
    const badge = screen.getByTitle(/does not confirm who redeemed it/)
    expect(badge).toHaveTextContent("Unverified")
    expect(badge).toHaveAttribute("data-assurance", "invited")
    // The sentence is split across elements by the emphasis on "you", so it is
    // read off the paragraph rather than any single text node.
    const explanation = document.querySelector(".inv-body-text")
    expect(explanation?.textContent).toMatch(/name you chose/)
  })

  it("keeps admit disabled until the fingerprint matches", async () => {
    const { did, onGrant } = await setup()
    const admit = screen.getByRole("button", { name: "Admit" })
    expect(admit).toBeDisabled()

    const input = screen.getByLabelText("Type it here to confirm")
    fireEvent.change(input, { target: { value: "WRONG-CODE-HERE-XXXX" } })
    expect(admit).toBeDisabled()

    fireEvent.change(input, { target: { value: await deviceFingerprint(did) } })
    await waitFor(() => {
      expect(admit).toBeEnabled()
    })

    fireEvent.click(admit)
    await waitFor(() => {
      expect(onGrant).toHaveBeenCalledTimes(1)
    })
  })

  it("flips the badge to verified once the codes match", async () => {
    const { did } = await setup()
    fireEvent.change(screen.getByLabelText("Type it here to confirm"), {
      target: { value: await deviceFingerprint(did) },
    })

    await waitFor(() => {
      expect(screen.getByTitle(/confirmed out of band/)).toHaveTextContent("Verified")
    })
  })

  // Admitting from a stale request is how a leaked old code gets used.
  it("refuses an expired invitation even with a matching fingerprint", async () => {
    const { did } = await setup({ ttlMs: DAY, now: T0 + 5 * DAY })

    expect(screen.getByRole("alert")).toHaveTextContent("expired")
    fireEvent.change(screen.getByLabelText("Type it here to confirm"), {
      target: { value: await deviceFingerprint(did) },
    })
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Admit" })).toBeDisabled()
    })
  })

  it("rejects without needing the fingerprint", async () => {
    const { onReject, onClose } = await setup()
    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it("renders nothing when closed or with nothing pending", () => {
    const { container } = render(
      <ApproveRedemptionDialog
        open={false}
        pending={null}
        onGrant={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe("PendingInvites", () => {
  // A list is where a name gets skimmed and taken as fact, so the badge has to
  // be at the point of skimming rather than only inside the dialog.
  it("badges every row as unverified, including ones the admin named", async () => {
    const { invitation, secret } = await anInvitation()
    const { redemption } = await aRedemption(invitation, secret)

    render(
      <PendingInvites
        invitations={[invitation]}
        awaiting={[{ invitation, redemption }]}
        onReview={vi.fn()}
        now={T0 + DAY}
      />,
    )

    const badges = screen.getAllByText("Unverified")
    expect(badges.length).toBeGreaterThan(0)
    for (const badge of badges) expect(badge).toHaveAttribute("data-assurance", "invited")
  })

  it("separates what needs a decision from what is merely sent", async () => {
    const answered = await anInvitation({ label: "Ada" })
    const unanswered = await anInvitation({ label: "Grace" })
    const { redemption } = await aRedemption(answered.invitation, answered.secret)

    render(
      <PendingInvites
        invitations={[answered.invitation, unanswered.invitation]}
        awaiting={[{ invitation: answered.invitation, redemption }]}
        onReview={vi.fn()}
        now={T0 + DAY}
      />,
    )

    expect(screen.getByRole("heading", { name: "Waiting for you" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Sent" })).toBeInTheDocument()
    // The answered one appears only under "Waiting for you".
    expect(screen.getAllByText("Ada")).toHaveLength(1)
  })

  it("marks an expired invitation", async () => {
    const { invitation } = await anInvitation({ ttlMs: DAY })
    render(
      <PendingInvites
        invitations={[invitation]}
        awaiting={[]}
        onReview={vi.fn()}
        now={T0 + 5 * DAY}
      />,
    )
    expect(screen.getByText(/^Expired/)).toBeInTheDocument()
  })

  it("says so when there is nothing outstanding", () => {
    render(<PendingInvites invitations={[]} awaiting={[]} onReview={vi.fn()} />)
    expect(screen.getByRole("status")).toHaveTextContent("No invitations outstanding")
  })

  it("hands the whole pending entry to the reviewer", async () => {
    const { invitation, secret } = await anInvitation()
    const { redemption } = await aRedemption(invitation, secret)
    const onReview = vi.fn()

    render(
      <PendingInvites
        invitations={[invitation]}
        awaiting={[{ invitation, redemption }]}
        onReview={onReview}
        now={T0 + DAY}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    expect(onReview).toHaveBeenCalledWith({ invitation, redemption })
  })
})

describe("IdentityBadge", () => {
  // Both weaker levels read as "Unverified" so a skim cannot mistake one for
  // the other; only the explanation differs.
  it("reads as unverified for anything short of a checked key", () => {
    const { rerender } = render(<IdentityBadge assurance="self-asserted" />)
    expect(screen.getByText("Unverified")).toHaveAttribute("data-assurance", "self-asserted")

    rerender(<IdentityBadge assurance="invited" />)
    expect(screen.getByText("Unverified")).toHaveAttribute("data-assurance", "invited")

    rerender(<IdentityBadge assurance="verified" />)
    expect(screen.getByText("Verified")).toHaveAttribute("data-assurance", "verified")
  })

  it("explains why each level is weak", () => {
    const { rerender } = render(<IdentityBadge assurance="self-asserted" />)
    expect(screen.getByTitle(/chosen by whoever is joining/)).toBeInTheDocument()

    rerender(<IdentityBadge assurance="invited" />)
    expect(screen.getByTitle(/does not confirm who redeemed it/)).toBeInTheDocument()
  })
})
