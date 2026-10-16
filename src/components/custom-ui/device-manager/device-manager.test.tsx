import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createUser, deviceFingerprint, type MemberDevice, type User } from "@/lib/identity"
import { admitDevice, asAdmitted, asLinked, linkDevice, newAdmin } from "@/test/identity-fixtures"
import { DeviceList } from "./device-list"
import { ApproveDeviceDialog } from "./approve-device-dialog"
import { SelfLinkWarning } from "./self-link-warning"
import { selfLinkStatus } from "./self-link-status"
import { ReAdmissionPanel } from "./re-admission-panel"
import { DeviceManagerDialog } from "./device-manager-dialog"

afterEach(cleanup)

/** A member with one admin-approved laptop and one self-linked phone. */
async function memberWithPhone(): Promise<{
  user: User
  laptop: MemberDevice
  phone: MemberDevice
}> {
  const admin = await newAdmin()
  const laptop = await admitDevice(admin, { member: "member:maren", label: "Maren" })
  const phone = await linkDevice(laptop)
  return {
    user: createUser("u1", [asAdmitted(laptop), asLinked(phone)]),
    laptop: asAdmitted(laptop),
    phone: asLinked(phone),
  }
}

describe("DeviceList", () => {
  it("distinguishes admin-approved devices from self-linked ones", async () => {
    const { user } = await memberWithPhone()
    render(<DeviceList devices={user.devices} />)

    expect(screen.getByText("Admin-approved")).toBeInTheDocument()
    expect(screen.getByText("Linked by you")).toBeInTheDocument()
  })

  it("marks the device being used right now", async () => {
    const { user, phone } = await memberWithPhone()
    render(<DeviceList devices={user.devices} currentDid={phone.record.did} />)
    expect(screen.getByText("This device")).toBeInTheDocument()
  })

  // Two devices can share a label; the fingerprint is the only way to tell
  // which is which.
  it("shows each device's fingerprint", async () => {
    const { user, laptop } = await memberWithPhone()
    render(<DeviceList devices={user.devices} />)

    const expected = await deviceFingerprint(laptop.record.did)
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument()
    })
  })

  it("offers removal for other devices but not the current one", async () => {
    const { user, laptop } = await memberWithPhone()
    const onRevoke = vi.fn()
    render(
      <DeviceList devices={user.devices} currentDid={laptop.record.did} onRevoke={onRevoke} />,
    )

    expect(screen.queryByRole("button", { name: /Remove Maren/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Remove member:maren/ }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it("says so when there are no devices", () => {
    render(<DeviceList devices={[]} />)
    expect(screen.getByRole("status")).toHaveTextContent("No devices yet")
  })
})

describe("selfLinkStatus", () => {
  it("is ok with two or more admin-approved devices", async () => {
    const admin = await newAdmin()
    const user = createUser("u1", [
      asAdmitted(await admitDevice(admin, { member: "m", label: "A" })),
      asAdmitted(await admitDevice(admin, { member: "m", label: "B" })),
    ])
    expect(selfLinkStatus(user).level).toBe("ok")
  })

  it("flags the last admin-approved device", async () => {
    const { user } = await memberWithPhone()
    expect(selfLinkStatus(user).level).toBe("last-one")
  })

  // The check that matters: computed against the set *after* removal.
  it("flags a removal that would strand the member", async () => {
    const { user, laptop } = await memberWithPhone()
    expect(selfLinkStatus(user, laptop).level).toBe("stranded")
  })

  it("does not flag removing a linked device", async () => {
    const { user, phone } = await memberWithPhone()
    expect(selfLinkStatus(user, phone).level).toBe("last-one")
  })
})

describe("SelfLinkWarning", () => {
  it("stays quiet when nothing is at risk", async () => {
    const admin = await newAdmin()
    const user = createUser("u1", [
      asAdmitted(await admitDevice(admin, { member: "m", label: "A" })),
      asAdmitted(await admitDevice(admin, { member: "m", label: "B" })),
    ])
    const { container } = render(<SelfLinkWarning user={user} />)
    expect(container).toBeEmptyDOMElement()
  })

  // Advice, not an alarm - losing the last one is a consequence, having one is
  // a fact.
  it("advises when this is the only admin-approved device", async () => {
    const { user } = await memberWithPhone()
    render(<SelfLinkWarning user={user} />)

    expect(screen.getByRole("status")).toHaveTextContent("only admin-approved device")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("raises an alert when the removal would strand the member", async () => {
    const { user, laptop } = await memberWithPhone()
    render(<SelfLinkWarning user={user} removing={laptop} />)

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("lock you out of adding devices")
    expect(alert).toHaveTextContent("need an admin")
  })
})

describe("ApproveDeviceDialog", () => {
  const pending = { did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }

  function setup(overrides: Partial<React.ComponentProps<typeof ApproveDeviceDialog>> = {}) {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const onClose = vi.fn()
    render(
      <ApproveDeviceDialog
        open
        pending={pending}
        onApprove={onApprove}
        onReject={onReject}
        onClose={onClose}
        {...overrides}
      />,
    )
    return { onApprove, onReject, onClose }
  }

  it("shows the fingerprint of the device asking to join", async () => {
    setup()
    const expected = await deviceFingerprint(pending.did)
    await waitFor(() => {
      expect(screen.getByLabelText("Expected fingerprint")).toHaveTextContent(expected)
    })
  })

  // The whole security value of the dialog. Approve must not be reachable
  // without the person having read the other screen.
  it("keeps approve disabled until the typed code matches", async () => {
    const { onApprove } = setup()
    const expected = await deviceFingerprint(pending.did)
    const approve = screen.getByRole("button", { name: /Approve device/ })
    const input = screen.getByLabelText("Type it here to confirm")

    expect(approve).toBeDisabled()

    fireEvent.change(input, { target: { value: "WRON-GXXX" } })
    expect(approve).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("does not match")

    fireEvent.change(input, { target: { value: expected } })
    await waitFor(() => {
      expect(approve).toBeEnabled()
    })
    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledWith(pending)
  })

  // The length is what makes forging a match not worth grinding for, so a
  // prefix must not be enough to get past the button.
  it("does not accept a truncated code", async () => {
    setup()
    const expected = await deviceFingerprint(pending.did)
    const input = screen.getByLabelText("Type it here to confirm")

    fireEvent.change(input, { target: { value: expected.slice(0, 9) } })
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("does not match")
    })
    expect(screen.getByRole("button", { name: /Approve device/ })).toBeDisabled()
  })

  it("accepts the code regardless of case and dashes", async () => {
    setup()
    const expected = await deviceFingerprint(pending.did)
    const input = screen.getByLabelText("Type it here to confirm")

    fireEvent.change(input, { target: { value: expected.replace(/-/g, "").toLowerCase() } })
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Approve device/ })).toBeEnabled()
    })
  })

  // The new device chose its own name, so it is shown as a claim.
  it("presents the claimed name as unverified", async () => {
    setup({ pending: { ...pending, claimedName: "Maren's iPhone" } })
    await waitFor(() => {
      expect(screen.getByText("Maren's iPhone")).toBeInTheDocument()
    })
    expect(screen.getByText(/not one we can verify/)).toBeInTheDocument()
  })

  it("rejects without needing the code", () => {
    const { onReject, onClose } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    expect(onReject).toHaveBeenCalledWith(pending)
    expect(onClose).toHaveBeenCalled()
  })

  it("renders nothing when closed or with no request", () => {
    const { container: closed } = render(
      <ApproveDeviceDialog
        open={false}
        pending={pending}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(closed).toBeEmptyDOMElement()

    const { container: none } = render(
      <ApproveDeviceDialog
        open
        pending={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(none).toBeEmptyDOMElement()
  })
})

describe("ReAdmissionPanel", () => {
  // The panel exists so total loss is a signposted path rather than a dead end.
  it("explains that recovery is impossible and re-admission is the way", () => {
    render(<ReAdmissionPanel fingerprint="K7QM-3XB9" did="did:key:z6MkTest" />)

    expect(screen.getByRole("heading", { name: /Lost all your devices/ })).toBeInTheDocument()
    expect(screen.getByText(/no way to recover an old device/)).toBeInTheDocument()
    expect(screen.getByLabelText("This device's fingerprint")).toHaveTextContent("K7QM-3XB9")
  })

  // Honest about the cost, rather than implying everything comes back.
  it("says history from before the loss does not come back", () => {
    render(<ReAdmissionPanel fingerprint="K7QM-3XB9" did="did:key:z6MkTest" />)
    expect(screen.getByText(/will\s+not come back with you/)).toBeInTheDocument()
  })

  it("copies the full device id", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<ReAdmissionPanel fingerprint="K7QM-3XB9" did="did:key:z6MkTest" />)
    fireEvent.click(screen.getByRole("button", { name: /Copy full device ID/ }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("did:key:z6MkTest")
    })
  })

  it("offers a request action only when the app has somewhere to send it", () => {
    const { rerender } = render(<ReAdmissionPanel fingerprint="X" did="did:key:z6MkTest" />)
    expect(screen.queryByRole("button", { name: /Request re-admission/ })).not.toBeInTheDocument()

    rerender(<ReAdmissionPanel fingerprint="X" did="did:key:z6MkTest" onRequest={vi.fn()} />)
    expect(screen.getByRole("button", { name: /Request re-admission/ })).toBeInTheDocument()
  })
})

describe("DeviceManagerDialog", () => {
  it("lists devices and offers the re-admission path", async () => {
    const { user } = await memberWithPhone()
    render(<DeviceManagerDialog open onClose={vi.fn()} user={user} />)

    expect(screen.getByRole("dialog", { name: "Your devices" })).toBeInTheDocument()
    expect(screen.getByText("Admin-approved")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /Lost all your devices/ })).toBeInTheDocument()
  })

  // The interaction that matters: removing the last admin-approved device
  // spells out the consequence before it happens, not after.
  it("warns with the consequence before confirming a stranding removal", async () => {
    const { user, laptop } = await memberWithPhone()
    const onRevoke = vi.fn()
    render(<DeviceManagerDialog open onClose={vi.fn()} user={user} onRevoke={onRevoke} />)

    fireEvent.click(screen.getByRole("button", { name: /Remove Maren/ }))

    const confirm = screen.getByRole("alertdialog", { name: "Confirm removal" })
    expect(confirm).toHaveTextContent("lock you out of adding devices")
    expect(onRevoke).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Remove device/ }))
    await waitFor(() => {
      expect(onRevoke).toHaveBeenCalledWith(laptop)
    })
  })

  it("lets the person back out of a removal", async () => {
    const { user } = await memberWithPhone()
    const onRevoke = vi.fn()
    render(<DeviceManagerDialog open onClose={vi.fn()} user={user} onRevoke={onRevoke} />)

    fireEvent.click(screen.getByRole("button", { name: /Remove Maren/ }))
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }))

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(onRevoke).not.toHaveBeenCalled()
  })

  // Two admins disagreeing about a name is an operator problem, and the byline
  // should say so rather than pick one.
  it("shows a conflicted name rather than choosing a winner", async () => {
    const admin = await newAdmin()
    const user = createUser("u1", [
      asAdmitted(await admitDevice(admin, { member: "m", label: "Maren" })),
      asAdmitted(await admitDevice(admin, { member: "m", label: "Someone Else" })),
    ])
    render(<DeviceManagerDialog open onClose={vi.fn()} user={user} />)

    // The header must not choose between them. Each device row still shows its
    // own admitted label, which is a fact about that device rather than a
    // claim about the person.
    const header = screen.getByRole("heading", { name: "Your devices" }).parentElement
    expect(header).toHaveTextContent("Name not agreed")
    expect(header).not.toHaveTextContent("Maren")
    expect(header).not.toHaveTextContent("Someone Else")
  })

  it("renders nothing when closed", async () => {
    const { user } = await memberWithPhone()
    const { container } = render(
      <DeviceManagerDialog open={false} onClose={vi.fn()} user={user} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
