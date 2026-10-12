import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { createUser, didFromSigningKey, type MemberDevice, type User } from "@/lib/identity"
import {
  issueCapability,
  type Ability,
  type AuthorizationContext,
  type Capability,
} from "@/lib/authz"
import type { FreshnessAssessment } from "@/lib/membership"
import { admitDevice, asAdmitted, asLinked, linkDevice, newAdmin } from "@/test/identity-fixtures"

import { AdmitMemberDialog, type AdmissionRequest } from "./admit-member-dialog"
import { ChangeLevelControl, type ChangeLevelRequest } from "./change-level-control"
import { DeviceRevocation, type LinkRevocationRequest } from "./device-revocation"
import { MemberList } from "./member-list"
import {
  canRevokeLink,
  freshnessCopy,
  memberViews,
  removalProgress,
  removalRequest,
  type MemberView,
  type PendingRemoval,
  type RemovalRequest,
} from "./membership-model"
import { MembershipPanel } from "./membership-panel"
import { RemoveMemberDialog } from "./remove-member-dialog"
import { RevocationStatus } from "./revocation-status"

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const RESOURCE = "notebook:travel"

afterEach(cleanup)

interface Party {
  key: SigningKey
  did: string
}

async function party(): Promise<Party> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

async function grant(
  issuer: Party,
  audience: string,
  options: { ability?: Ability; resource?: string; depth?: number } = {},
): Promise<Capability> {
  return issueCapability({
    signingKey: issuer.key,
    issuer: issuer.did,
    audience,
    resource: options.resource ?? RESOURCE,
    ability: options.ability ?? "write",
    depth: options.depth ?? 0,
    notBefore: T0 - DAY,
    expiresAt: T0 + 30 * DAY,
  })
}

function contextOf(
  owner: string,
  capabilities: readonly Capability[],
  revoked: Iterable<string> = [],
): AuthorizationContext {
  return {
    proofs: new Map(capabilities.map((capability) => [capability.cid, capability])),
    owner,
    now: T0,
    revoked: new Set(revoked),
  }
}

/** A member with one admitted device, and optionally a self-linked one. */
async function aMember(
  admin: Awaited<ReturnType<typeof newAdmin>>,
  options: { member?: string; label?: string; linked?: boolean } = {},
): Promise<{ user: User; devices: MemberDevice[]; admittedDid: string; linkedDid?: string }> {
  const admitted = await admitDevice(admin, {
    member: options.member ?? "member:ada",
    label: options.label ?? "Ada Lovelace",
  })
  const devices: MemberDevice[] = [asAdmitted(admitted)]
  let linkedDid: string | undefined

  if (options.linked) {
    const linked = await linkDevice(admitted)
    devices.push(asLinked(linked))
    linkedDid = linked.record.did
  }

  return {
    user: createUser(options.member ?? "member:ada", devices),
    devices,
    admittedDid: admitted.record.did,
    ...(linkedDid === undefined ? {} : { linkedDid }),
  }
}

const FRESH: FreshnessAssessment = { state: "fresh", ageMs: 30_000 }

/* ---- the model ----------------------------------------------------------- */

describe("memberViews", () => {
  it("lists a person with no access here rather than hiding them", async () => {
    const admin = await newAdmin()
    const { user } = await aMember(admin)

    const [view] = await memberViews([user], [], RESOURCE, contextOf(admin.did, []))

    expect(view.ability).toBeNull()
    expect(view.principals).toHaveLength(0)
  })

  /**
   * Capabilities address device keys, not people. A view that collapsed a
   * member to one principal would leave keys behind on every operation.
   */
  it("gathers every device key a member holds access through", async () => {
    const admin = await newAdmin()
    const { user, devices } = await aMember(admin, { linked: true })
    const caps = await Promise.all(
      devices.map((device) => grant(admin, device.record.did, { ability: "read" })),
    )

    const [view] = await memberViews([user], caps, RESOURCE, contextOf(admin.did, caps))

    expect(view.principals).toHaveLength(2)
    expect(view.held).toHaveLength(2)
  })

  it("reports the strongest level across their keys", async () => {
    const admin = await newAdmin()
    const { user, devices } = await aMember(admin, { linked: true })
    const caps = [
      await grant(admin, devices[0].record.did, { ability: "read" }),
      await grant(admin, devices[1].record.did, { ability: "admin" }),
    ]

    const [view] = await memberViews([user], caps, RESOURCE, contextOf(admin.did, caps))
    expect(view.ability).toBe("admin")
  })

  it("never shows an admission as a verified identity", async () => {
    const admin = await newAdmin()
    const { user } = await aMember(admin)

    const [view] = await memberViews([user], [], RESOURCE, contextOf(admin.did, []))
    expect(view.assurance).toBe("invited")
  })

  it("surfaces conflicting admin-attested names instead of picking one", async () => {
    const adminA = await newAdmin()
    const adminB = await newAdmin()
    const first = await admitDevice(adminA, { member: "member:ada", label: "Ada" })
    const second = await admitDevice(adminB, { member: "member:ada", label: "A. Lovelace" })
    const user = createUser("member:ada", [asAdmitted(first), asAdmitted(second)])

    const [view] = await memberViews([user], [], RESOURCE, contextOf(adminA.did, []))

    expect(view.labelConflict).toEqual(["A. Lovelace", "Ada"])
  })

  it("drops access whose capability has been revoked", async () => {
    const admin = await newAdmin()
    const { user, admittedDid } = await aMember(admin)
    const cap = await grant(admin, admittedDid)

    const [view] = await memberViews([user], [cap], RESOURCE, contextOf(admin.did, [cap], [cap.cid]))
    expect(view.ability).toBeNull()
  })
})

describe("removalRequest", () => {
  it("reaches every key, because one left behind is access left behind", async () => {
    const admin = await newAdmin()
    const { user, devices } = await aMember(admin, { linked: true })
    const caps = await Promise.all(devices.map((device) => grant(admin, device.record.did)))

    const [view] = await memberViews([user], caps, RESOURCE, contextOf(admin.did, caps))
    const request = removalRequest(view)

    expect(request.deviceDids).toHaveLength(2)
    expect(request.held).toHaveLength(2)
  })
})

/* ---- the latency window -------------------------------------------------- */

describe("removalProgress", () => {
  const removal: PendingRemoval = {
    label: "Ada",
    revocationCids: ["cid-a", "cid-b"],
    removedAt: T0,
  }

  /** Reads stop on rotation, which does not depend on anything propagating. */
  it("treats reads as blocked in every phase", () => {
    for (const assessment of [
      FRESH,
      { state: "stale" as const, ageMs: 2 * 60 * 60 * 1000 },
      { state: "regressed" as const },
      { state: "missing" as const },
    ]) {
      const progress = removalProgress(removal, assessment, [], T0 + MINUTE)
      expect(progress.readsBlocked).toBe(true)
    }
  })

  it("calls an ordinary in-flight removal settling, not a problem", () => {
    const progress = removalProgress(removal, FRESH, [], T0 + MINUTE)

    expect(progress.phase).toBe("settling")
    expect(progress.needsAttention).toBe(false)
    expect(progress.detail).toMatch(/usually takes seconds/)
  })

  /**
   * Settled is a real check against the relay's published digest, not a timer.
   */
  it("confirms only when the relay's own set is known to contain the withdrawal", () => {
    const partial = removalProgress(removal, FRESH, ["cid-a"], T0 + MINUTE)
    expect(partial.phase).toBe("settling")

    const full = removalProgress(removal, FRESH, ["cid-a", "cid-b"], T0 + MINUTE)
    expect(full.phase).toBe("settled")
    expect(full.writesBlockedEverywhere).toBe(true)
  })

  it("refuses to call it settled when the local set disagrees with the relay's", () => {
    const progress = removalProgress(
      removal,
      { state: "fresh", ageMs: 1000, setMismatch: true },
      ["cid-a", "cid-b"],
      T0 + MINUTE,
    )

    expect(progress.phase).toBe("unconfirmable")
    expect(progress.detail).toMatch(/does not match/)
  })

  it("escalates once an ordinary wait has gone on too long", () => {
    const progress = removalProgress(removal, FRESH, [], T0 + 30 * MINUTE)

    expect(progress.phase).toBe("unconfirmable")
    expect(progress.needsAttention).toBe(true)
  })

  it("distinguishes a withheld list from a rolled-back one", () => {
    const withheld = removalProgress(
      removal,
      { state: "stale", ageMs: 3 * 60 * 60 * 1000 },
      [],
      T0 + MINUTE,
    )
    expect(withheld.detail).toMatch(/has not advanced/)

    const rolledBack = removalProgress(removal, { state: "regressed" }, [], T0 + MINUTE)
    expect(rolledBack.detail).toMatch(/older list of withdrawals/)
  })

  /** Even when it cannot be confirmed, the frightening reading is still wrong. */
  it("still says reading is blocked when the removal cannot be confirmed", () => {
    const progress = removalProgress(removal, { state: "missing" }, [], T0 + MINUTE)

    expect(progress.phase).toBe("unconfirmable")
    expect(progress.detail).toMatch(/still cannot read anything new/)
  })
})

describe("freshnessCopy", () => {
  it("treats being behind as ordinary and a rollback as not", () => {
    expect(freshnessCopy({ state: "stale", ageMs: DAY }).tone).toBe("warn")
    expect(freshnessCopy({ state: "stale", ageMs: DAY }).detail).toMatch(/normal after being offline/)
    expect(freshnessCopy({ state: "regressed" }).tone).toBe("alarm")
  })

  it("says reading is unaffected when nothing has been confirmed yet", () => {
    expect(freshnessCopy({ state: "missing" }).detail).toMatch(/Reading is unaffected/)
  })
})

describe("canRevokeLink", () => {
  it("allows an admin-admitted device of the same member, and nothing else", async () => {
    const admin = await newAdmin()
    const { devices, admittedDid, linkedDid } = await aMember(admin, { linked: true })
    const stranger = await party()

    expect(canRevokeLink(devices, admittedDid, "member:ada", linkedDid!)).toBe(true)
    expect(canRevokeLink(devices, stranger.did, "member:ada", linkedDid!)).toBe(false)
    // A linked device can neither unlink itself nor act at all.
    expect(canRevokeLink(devices, linkedDid!, "member:ada", linkedDid!)).toBe(false)
  })
})

/* ---- the components ------------------------------------------------------ */

describe("RevocationStatus", () => {
  const removal: PendingRemoval = { label: "Ada", revocationCids: ["cid-a"], removedAt: T0 }

  it("says what is already true alongside what is still spreading", () => {
    render(<RevocationStatus assessment={FRESH} pending={[removal]} now={T0 + MINUTE} />)

    expect(screen.getByText(/Reading: stopped immediately/)).toBeInTheDocument()
    expect(screen.getByText(/Writing: stopping as devices catch up/)).toBeInTheDocument()
    expect(screen.getByText("Ada is being removed.")).toBeInTheDocument()
  })

  it("marks writing as done only once the withdrawal is confirmed everywhere", () => {
    render(
      <RevocationStatus
        assessment={FRESH}
        pending={[removal]}
        localRevokedIds={["cid-a"]}
        now={T0 + MINUTE}
      />,
    )

    expect(screen.getByText(/Writing: stopped everywhere/)).toBeInTheDocument()
    expect(screen.getByText("Ada has been removed.")).toBeInTheDocument()
  })

  it("raises an alert when a rolled-back list is seen", () => {
    render(<RevocationStatus assessment={{ state: "regressed" }} now={T0} />)

    expect(screen.getByRole("alert")).toHaveTextContent(/out-of-date list of withdrawals/)
  })

  it("does not repeat the freshness line beside a settled removal", () => {
    render(
      <RevocationStatus
        assessment={FRESH}
        pending={[removal]}
        localRevokedIds={["cid-a"]}
        now={T0 + MINUTE}
      />,
    )

    expect(screen.queryByText("Withdrawals are up to date.")).not.toBeInTheDocument()
  })
})

describe("RemoveMemberDialog", () => {
  async function setup(options: { remaining?: { did: string; label: string }[] } = {}) {
    const admin = await newAdmin()
    const { user, devices } = await aMember(admin, { linked: true })
    const caps = await Promise.all(devices.map((device) => grant(admin, device.record.did)))
    const [member] = await memberViews([user], caps, RESOURCE, contextOf(admin.did, caps))
    const onRemove = vi.fn().mockResolvedValue(undefined)

    render(
      <RemoveMemberDialog
        open
        onClose={vi.fn()}
        member={member}
        remaining={options.remaining ?? [{ did: "did:key:zBob", label: "Bob" }]}
        onRemove={onRemove}
      />,
    )
    return { member, onRemove }
  }

  it("separates what stops now from what stops as it spreads", async () => {
    await setup()

    expect(screen.getByText("Reading stops straight away.")).toBeInTheDocument()
    expect(screen.getByText("Writing stops as this spreads.")).toBeInTheDocument()
    expect(screen.getByText(/that is the system working, not\s+failing/)).toBeInTheDocument()
  })

  it("says what removal cannot undo", async () => {
    await setup()

    expect(screen.getByText(/keep everything they have already read/)).toBeInTheDocument()
    expect(screen.getByText(/Their copy stays on their device to\s+read/)).toBeInTheDocument()
  })

  it("withdraws every key of the member, and says how many", async () => {
    const { onRemove } = await setup()

    expect(screen.getByText("This withdraws 2 device keys")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^Remove Ada Lovelace/ }))

    await waitFor(() => expect(onRemove).toHaveBeenCalled())
    expect((onRemove.mock.calls[0][0] as RemovalRequest).deviceDids).toHaveLength(2)
  })

  /** The reseal goes to exactly this list, so an empty one locks everyone out. */
  it("refuses to proceed when nobody is listed as keeping access", async () => {
    await setup({ remaining: [] })

    expect(screen.getByText("Nobody else is listed.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Remove Ada Lovelace/ })).toBeDisabled()
  })

  it("passes the reason through with the withdrawal", async () => {
    const { onRemove } = await setup()

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "left the team" } })
    fireEvent.click(screen.getByRole("button", { name: /^Remove Ada Lovelace/ }))

    await waitFor(() => expect(onRemove).toHaveBeenCalled())
    expect(onRemove.mock.calls[0][1]).toBe("left the team")
  })
})

describe("AdmitMemberDialog", () => {
  async function setup(overrides: Partial<MemberView> = {}) {
    const admin = await newAdmin()
    const { user } = await aMember(admin)
    const [base] = await memberViews([user], [], RESOURCE, contextOf(admin.did, []))
    const onAdmit = vi.fn().mockResolvedValue(undefined)

    render(
      <AdmitMemberDialog
        open
        onClose={vi.fn()}
        member={{ ...base, ...overrides }}
        resourceLabel="this notebook"
        onAdmit={onAdmit}
        now={T0}
      />,
    )
    return { onAdmit }
  }

  it("separates workspace membership from access to this notebook", async () => {
    await setup()
    expect(screen.getByText(/already in this workspace/)).toBeInTheDocument()
  })

  /** Both wrong assumptions about admission, addressed before the button. */
  it("says they get the current contents in full, and not the earlier history", async () => {
    await setup()

    expect(screen.getByText(/as it stands now, in full/)).toBeInTheDocument()
    expect(screen.getByText(/do not get the edit history from before today/)).toBeInTheDocument()
  })

  it("starts at the weakest level", async () => {
    const { onAdmit } = await setup()

    fireEvent.click(screen.getByRole("button", { name: "Give access" }))
    await waitFor(() => expect(onAdmit).toHaveBeenCalled())
    expect((onAdmit.mock.calls[0][0] as AdmissionRequest).ability).toBe("read")
  })

  it("blocks admission when there is no admin-admitted key to seal to", async () => {
    await setup({ devices: [] })

    expect(screen.getByText("They have no admin-admitted device.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Give access" })).toBeDisabled()
  })

  it("stops on a conflicted name rather than handing over keys", async () => {
    await setup({ labelConflict: ["Ada", "A. Lovelace"] })

    expect(screen.getByText(/different names/)).toBeInTheDocument()
  })

  /** `assertKeyringCurrent` throws before anything is cut. It has a remedy. */
  it("explains a stale keyring specifically, and says nothing was handed over", async () => {
    const admin = await newAdmin()
    const { user } = await aMember(admin)
    const [member] = await memberViews([user], [], RESOURCE, contextOf(admin.did, []))

    render(
      <AdmitMemberDialog
        open
        onClose={vi.fn()}
        member={member}
        resourceLabel="this notebook"
        onAdmit={() => {
          throw new Error("keyring is at epoch 3, domain timeline is at epoch 5")
        }}
        now={T0}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Give access" }))
    await waitFor(() =>
      expect(screen.getByText("Your copy of the keys is out of date.")).toBeInTheDocument(),
    )
    expect(screen.getByText(/Nothing was handed over/)).toBeInTheDocument()
  })
})

describe("ChangeLevelControl", () => {
  async function setup() {
    const admin = await newAdmin()
    const { user, devices } = await aMember(admin, { linked: true })
    const caps = await Promise.all(
      devices.map((device) => grant(admin, device.record.did, { ability: "read" })),
    )
    const [member] = await memberViews([user], caps, RESOURCE, contextOf(admin.did, caps))
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onRemoveInstead = vi.fn()

    render(
      <ChangeLevelControl
        member={member}
        onSave={onSave}
        onCancel={vi.fn()}
        onRemoveInstead={onRemoveInstead}
      />,
    )
    return { member, onSave, onRemoveInstead }
  }

  /**
   * "No access" as a fourth level would leave a member with no capability still
   * holding the current key - the opposite of what was intended.
   */
  it("offers no way to take away access, and routes that to removal", async () => {
    const { onRemoveInstead } = await setup()

    expect(screen.queryByLabelText(/No access/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Take away access entirely instead/))
    expect(onRemoveInstead).toHaveBeenCalled()
  })

  it("says a downgrade does not stop them reading", async () => {
    await setup()

    fireEvent.click(screen.getByLabelText(/Can edit/))
    expect(screen.getByText(/every level includes reading/)).toBeInTheDocument()
  })

  it("withdraws before issuing, and covers every key", async () => {
    const { onSave } = await setup()

    expect(screen.getByText(/withdrawn first, then the new one is issued/)).toBeInTheDocument()
    expect(screen.getByText(/2 grants are withdrawn/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Can edit/))
    fireEvent.click(screen.getByRole("button", { name: "Save level" }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const change = onSave.mock.calls[0][0] as ChangeLevelRequest
    expect(change.ability).toBe("write")
    expect(change.held).toHaveLength(2)
  })
})

describe("DeviceRevocation", () => {
  it("offers unlink only for a self-linked device, from an entitled one", async () => {
    const admin = await newAdmin()
    const { devices, admittedDid } = await aMember(admin, { linked: true })

    render(
      <DeviceRevocation
        devices={devices}
        actingDid={admittedDid}
        member="member:ada"
        onRevokeLink={vi.fn()}
      />,
    )

    await screen.findAllByText(/Admin-admitted|Self-linked/)
    const unlink = screen.getByRole("button", { name: /^Unlink/ })
    expect(unlink).toBeEnabled()
    // The admitted device has no unlink control at all.
    expect(screen.getAllByRole("button", { name: /^Unlink/ })).toHaveLength(1)
    expect(screen.getByText(/membership change, not a device change/)).toBeInTheDocument()
  })

  it("will not let a linked device unlink itself", async () => {
    const admin = await newAdmin()
    const { devices, linkedDid } = await aMember(admin, { linked: true })

    render(
      <DeviceRevocation
        devices={devices}
        actingDid={linkedDid!}
        member="member:ada"
        onRevokeLink={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: /^Unlink/ })).toBeDisabled()
  })

  /** Unlinking does not rotate. Claiming it did would be the worse failure. */
  it("does not claim unlinking replaces the key, and points at what does", async () => {
    const admin = await newAdmin()
    const { devices, admittedDid, linkedDid } = await aMember(admin, { linked: true })
    const onRevokeLink = vi.fn().mockResolvedValue(undefined)

    render(
      <DeviceRevocation
        devices={devices}
        actingDid={admittedDid}
        member="member:ada"
        onRevokeLink={onRevokeLink}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /^Unlink/ }))
    expect(screen.getByText(/keeps the\s+content key it already holds/)).toBeInTheDocument()
    expect(screen.getByText(/remove the member instead/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }))
    await waitFor(() => expect(onRevokeLink).toHaveBeenCalled())
    expect((onRevokeLink.mock.calls[0][0] as LinkRevocationRequest).device.record.did).toBe(linkedDid)
  })
})

describe("MemberList", () => {
  async function views(options: { ability?: Ability } = {}) {
    const admin = await newAdmin()
    const ada = await aMember(admin, { member: "member:ada", label: "Ada Lovelace" })
    const bob = await aMember(admin, { member: "member:bob", label: "Bob" })
    const caps = options.ability
      ? [await grant(admin, ada.admittedDid, { ability: options.ability })]
      : []

    return memberViews([ada.user, bob.user], caps, RESOURCE, contextOf(admin.did, caps))
  }

  it("lists people with no access here, with the way in beside them", async () => {
    const members = await views()
    const onAdmit = vi.fn()

    render(
      <MemberList
        members={members}
        resourceLabel="this notebook"
        actingDid="did:key:zX"
        onAdmit={onAdmit}
      />,
    )

    expect(screen.getAllByText(/no access to this notebook/)).toHaveLength(2)
    fireEvent.click(screen.getAllByRole("button", { name: /Give .* access/ })[0])
    expect(onAdmit).toHaveBeenCalled()
  })

  /** Vanishing on click would look better and be untrue. */
  it("keeps a member whose removal is still spreading, labelled", async () => {
    const members = await views({ ability: "write" })
    const pending: PendingRemoval[] = [
      { label: "Ada Lovelace", revocationCids: ["cid-a"], removedAt: T0 },
    ]

    render(
      <MemberList
        members={members}
        resourceLabel="this notebook"
        actingDid="did:key:zX"
        pending={pending}
        onRemove={vi.fn()}
        onChangeLevel={vi.fn()}
      />,
    )

    expect(screen.getByText("Removing…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Remove Ada Lovelace/ })).toBeDisabled()
  })
})

describe("MembershipPanel", () => {
  async function setup() {
    const admin = await newAdmin()
    const ada = await aMember(admin, { member: "member:ada", label: "Ada Lovelace" })
    const bob = await aMember(admin, { member: "member:bob", label: "Bob" })
    const caps = [
      await grant(admin, ada.admittedDid, { ability: "write" }),
      await grant(admin, bob.admittedDid, { ability: "read" }),
    ]
    const onRemove = vi.fn().mockResolvedValue(undefined)

    render(
      <MembershipPanel
        users={[ada.user, bob.user]}
        capabilities={caps}
        resource={RESOURCE}
        resourceLabel="this notebook"
        context={contextOf(admin.did, caps)}
        actingDid={ada.admittedDid}
        assessment={FRESH}
        pending={[{ label: "Carol", revocationCids: ["cid-c"], removedAt: T0 }]}
        onAdmit={vi.fn()}
        onRemove={onRemove}
        onChangeLevel={vi.fn()}
        onRevokeLink={vi.fn()}
        now={T0 + MINUTE}
      />,
    )
    return { onRemove }
  }

  it("puts the removal status above the list, not inside a row", async () => {
    await setup()

    expect(screen.getByText("Carol is being removed.")).toBeInTheDocument()
    await screen.findByText("Ada Lovelace")
  })

  /** The reseal set is derived from the same verified view the list is drawn from. */
  it("offers everyone who keeps access as the reseal set, minus the one being removed", async () => {
    const { onRemove } = await setup()
    await screen.findByText("Ada Lovelace")

    fireEvent.click(screen.getByRole("button", { name: /Remove Ada Lovelace/ }))

    // Bob is in the list behind the dialog too, so this is read off the dialog.
    const dialog = screen.getByRole("dialog", { name: /Remove Ada Lovelace/ })
    expect(within(dialog).getByText("Bob")).toBeInTheDocument()
    expect(screen.queryByText("Nobody else is listed.")).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove Ada Lovelace/ }))
    await waitFor(() => expect(onRemove).toHaveBeenCalled())
  })
})
