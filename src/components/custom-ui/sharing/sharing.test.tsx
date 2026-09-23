import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  issueCapability,
  revokeCapability,
  type Ability,
  type AuthorizationContext,
  type Capability,
} from "@/lib/authz"

import {
  grantBudget,
  removalPlan,
  summarizeAccess,
  type GrantRequest,
  type Person,
  type RemovalPlan,
} from "./access-model"
import { AccessLevelPicker } from "./access-level-picker"
import { AccessList } from "./access-list"
import { ShareDialog } from "./share-dialog"
import { SharingDialog } from "./sharing-dialog"

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const NOTEBOOK = "notebook:travel"
const NOTE = "notebook:travel/note:kyoto"

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
  audience: Party,
  options: {
    ability?: Ability
    resource?: string
    depth?: number
    proof?: string | null
    notBefore?: number
    expiresAt?: number
  } = {},
): Promise<Capability> {
  return issueCapability({
    signingKey: issuer.key,
    issuer: issuer.did,
    audience: audience.did,
    resource: options.resource ?? NOTEBOOK,
    ability: options.ability ?? "read",
    depth: options.depth ?? 0,
    proof: options.proof ?? null,
    notBefore: options.notBefore ?? T0 - DAY,
    expiresAt: options.expiresAt ?? T0 + 30 * DAY,
  })
}

function contextOf(
  owner: string,
  capabilities: readonly Capability[],
  options: { now?: number; revoked?: Iterable<string> } = {},
): AuthorizationContext {
  return {
    proofs: new Map(capabilities.map((capability) => [capability.cid, capability])),
    owner,
    now: options.now ?? T0,
    revoked: new Set(options.revoked ?? []),
  }
}

function person(did: string, label: string, assurance: Person["assurance"] = "verified"): Person {
  return { did, label, assurance }
}

/* ---- the model ----------------------------------------------------------- */

describe("summarizeAccess", () => {
  /**
   * The case a note-scoped list would get wrong: nearly everyone who can read a
   * note holds a notebook grant, not a note grant.
   */
  it("includes access inherited from an ancestor resource, and says where from", async () => {
    const owner = await party()
    const ada = await party()
    const notebookGrant = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })

    const entries = await summarizeAccess([notebookGrant], NOTE, contextOf(owner.did, [notebookGrant]))

    expect(entries).toHaveLength(1)
    expect(entries[0].ability).toBe("write")
    expect(entries[0].inheritedFrom).toBe(NOTEBOOK)
  })

  it("reports the strongest of several grants, not the last one seen", async () => {
    const owner = await party()
    const ada = await party()
    const weak = await grant(owner, ada, { ability: "read", resource: NOTE })
    const strong = await grant(owner, ada, { ability: "admin", resource: NOTEBOOK })

    const entries = await summarizeAccess([weak, strong], NOTE, contextOf(owner.did, [weak, strong]))

    expect(entries).toHaveLength(1)
    expect(entries[0].ability).toBe("admin")
    expect(entries[0].grants).toHaveLength(2)
  })

  it("omits revoked, expired and unchained capabilities", async () => {
    const owner = await party()
    const stranger = await party()
    const ada = await party()
    const bob = await party()
    const carol = await party()

    const revoked = await grant(owner, ada, { resource: NOTEBOOK })
    const expired = await grant(owner, bob, { resource: NOTEBOOK, expiresAt: T0 - 1 })
    // A root nobody with authority issued. Signed, well formed, and worthless.
    const forged = await grant(stranger, carol, { resource: NOTEBOOK })

    const all = [revoked, expired, forged]
    const entries = await summarizeAccess(
      all,
      NOTEBOOK,
      contextOf(owner.did, all, { revoked: [revoked.cid] }),
    )

    expect(entries).toHaveLength(0)
  })

  it("prefers the direct grant when two grants confer the same level", async () => {
    const owner = await party()
    const ada = await party()
    const wide = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })
    const narrow = await grant(owner, ada, { ability: "write", resource: NOTE })

    const entries = await summarizeAccess([wide, narrow], NOTE, contextOf(owner.did, [wide, narrow]))

    expect(entries[0].inheritedFrom).toBeNull()
    expect(entries[0].via.capability.cid).toBe(narrow.cid)
  })
})

describe("removalPlan", () => {
  it("withdraws every grant, since the weaker one would leave access standing", async () => {
    const owner = await party()
    const ada = await party()
    const read = await grant(owner, ada, { ability: "read", resource: NOTE })
    const write = await grant(owner, ada, { ability: "write", resource: NOTE })

    const [entry] = await summarizeAccess([read, write], NOTE, contextOf(owner.did, [read, write]))
    const plan = removalPlan(entry, NOTE, owner.did, owner.did)

    expect(plan.revoke).toHaveLength(2)
    expect(plan.partial).toBe(false)
  })

  it("flags a grant that reaches past the resource being looked at", async () => {
    const owner = await party()
    const ada = await party()
    const wide = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })

    const [entry] = await summarizeAccess([wide], NOTE, contextOf(owner.did, [wide]))
    const plan = removalPlan(entry, NOTE, owner.did, owner.did)

    expect(plan.wider).toHaveLength(1)
  })

  /** The rule `verifyRevocation` enforces: you cannot take back what you never gave. */
  it("marks a grant issued by someone else as one this actor cannot withdraw", async () => {
    const owner = await party()
    const admin = await party()
    const ada = await party()
    const bystander = await party()

    const adminCap = await grant(owner, admin, { ability: "admin", depth: 2 })
    const adaCap = await grant(admin, ada, { ability: "write", proof: adminCap.cid })
    const all = [adminCap, adaCap]

    const [entry] = await summarizeAccess([adaCap], NOTEBOOK, contextOf(owner.did, all))
    const plan = removalPlan(entry, NOTEBOOK, bystander.did, owner.did)

    expect(plan.revoke).toHaveLength(0)
    expect(plan.blocked).toHaveLength(1)
    expect(plan.partial).toBe(true)

    // The admin who issued it can, because they are on the chain.
    expect(removalPlan(entry, NOTEBOOK, admin.did, owner.did).revoke).toHaveLength(1)
  })
})

describe("grantBudget", () => {
  it("gives the owner the full range", async () => {
    const owner = await party()
    const budget = await grantBudget(owner.did, NOTEBOOK, contextOf(owner.did, []))

    expect(budget.maxAbility).toBe("admin")
    expect(budget.proof).toBeNull()
    expect(budget.maxDepth).toBeGreaterThan(0)
  })

  /**
   * A non-delegable leaf is access without the right to pass it on. Offering to
   * share it would produce a token the verifier refuses.
   */
  it("refuses sharing from a non-delegable leaf, and says why", async () => {
    const owner = await party()
    const ada = await party()
    const leaf = await grant(owner, ada, { ability: "write", depth: 0 })

    const budget = await grantBudget(ada.did, NOTEBOOK, contextOf(owner.did, [leaf]))

    expect(budget.maxAbility).toBeNull()
    expect(budget.reason).toMatch(/right to pass it on/i)
  })

  it("caps ability, depth and expiry at what the actor holds", async () => {
    const owner = await party()
    const ada = await party()
    const held = await grant(owner, ada, {
      ability: "write",
      depth: 2,
      expiresAt: T0 + 10 * DAY,
    })

    const budget = await grantBudget(ada.did, NOTEBOOK, contextOf(owner.did, [held]))

    expect(budget.maxAbility).toBe("write")
    expect(budget.maxDepth).toBe(1)
    expect(budget.notAfter).toBe(T0 + 10 * DAY)
  })

  it("says plainly when the actor has no access at all", async () => {
    const owner = await party()
    const stranger = await party()

    const budget = await grantBudget(stranger.did, NOTEBOOK, contextOf(owner.did, []))

    expect(budget.maxAbility).toBeNull()
    expect(budget.reason).toMatch(/do not have access/i)
  })
})

/* ---- the level picker ---------------------------------------------------- */

describe("AccessLevelPicker", () => {
  /**
   * The reason this is radios and not a dropdown: a dropdown hides what the
   * other levels would have meant, so the comparison never happens.
   */
  it("shows what every level means at once, not just the chosen one", () => {
    render(<AccessLevelPicker value="read" onChange={vi.fn()} />)

    expect(screen.getByText(/Cannot change anything/)).toBeInTheDocument()
    expect(screen.getByText(/plus write, rename and delete/)).toBeInTheDocument()
    expect(screen.getByText(/plus share it with other people/)).toBeInTheDocument()
  })

  it("locks levels above the ceiling rather than hiding them, and gives the reason", () => {
    render(
      <AccessLevelPicker
        value="read"
        onChange={vi.fn()}
        max="write"
        ceilingReason="You can share at most your own level, write."
      />,
    )

    expect(screen.getByLabelText(/Can manage access/)).toBeDisabled()
    expect(screen.getByLabelText(/Can edit/)).toBeEnabled()
    expect(screen.getByText(/at most your own level/)).toBeInTheDocument()
  })

  it("does not report a choice the ceiling forbids", () => {
    const onChange = vi.fn()
    render(<AccessLevelPicker value="read" onChange={onChange} max="read" />)

    fireEvent.click(screen.getByLabelText(/Can manage access/))
    expect(onChange).not.toHaveBeenCalled()
  })
})

/* ---- the share dialog ---------------------------------------------------- */

async function shareSetup(
  options: {
    capabilities?: Capability[]
    actorIsOwner?: boolean
    scopes?: { resource: string; label: string; covers: string }[]
  } = {},
) {
  const owner = await party()
  const ada = await party()
  const onGrant = vi.fn().mockResolvedValue(undefined)
  const capabilities = options.capabilities ?? []
  const context = contextOf(owner.did, capabilities)

  render(
    <ShareDialog
      open
      onClose={vi.fn()}
      scopes={
        options.scopes ?? [
          { resource: NOTE, label: "this note", covers: "Only this note." },
          {
            resource: NOTEBOOK,
            label: "the whole notebook",
            covers: "Every note in it, including ones added later.",
          },
        ]
      }
      candidates={[person(ada.did, "Ada Lovelace")]}
      capabilities={capabilities}
      context={context}
      actor={owner.did}
      onGrant={onGrant}
    />,
  )

  await screen.findByText("Ada Lovelace")
  return { owner, ada, onGrant }
}

describe("ShareDialog", () => {
  it("defaults to the narrowest scope, and says what the wider one reaches", async () => {
    await shareSetup()

    const narrow = screen.getByRole("radio", { name: /this note/ })
    expect(narrow).toBeChecked()
    expect(screen.getByText(/including ones added later/)).toBeInTheDocument()
  })

  /** Re-sharing is the thing that lets access spread out of view. */
  it("leaves re-sharing off, and grants depth 0 when it is not turned on", async () => {
    const { ada, onGrant } = await shareSetup()

    expect(screen.getByLabelText(/Let them share this on/)).not.toBeChecked()
    fireEvent.click(screen.getByText("Ada Lovelace"))
    fireEvent.click(screen.getByRole("button", { name: /^Give read/ }))

    await waitFor(() => expect(onGrant).toHaveBeenCalled())
    expect(onGrant.mock.calls[0][0]).toMatchObject({
      audience: ada.did,
      resource: NOTE,
      ability: "read",
      depth: 0,
    })
  })

  it("spells out what manage access means before it can be granted", async () => {
    await shareSetup()

    fireEvent.click(screen.getByText("Ada Lovelace"))
    expect(screen.queryByText(/people you have not met/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Can manage access/))
    expect(screen.getByText(/people you have not met/)).toBeInTheDocument()
    expect(screen.getByText(/removes everyone they shared with too/)).toBeInTheDocument()
  })

  /**
   * The misconception this exists to break: that adding a narrow grant limits
   * someone. Grants only ever add.
   */
  it("warns that a narrower grant will not reduce wider access they already have", async () => {
    const owner = await party()
    const ada = await party()
    const wide = await grant(owner, ada, { ability: "admin", resource: NOTEBOOK, depth: 1 })
    const context = contextOf(owner.did, [wide])
    const onGrant = vi.fn()

    render(
      <ShareDialog
        open
        onClose={vi.fn()}
        scopes={[{ resource: NOTE, label: "this note", covers: "Only this note." }]}
        candidates={[person(ada.did, "Ada Lovelace")]}
        capabilities={[wide]}
        context={context}
        actor={owner.did}
        onGrant={onGrant}
      />,
    )

    fireEvent.click(await screen.findByText("Ada Lovelace"))

    await waitFor(() =>
      expect(screen.getByText(/does not take the wider one away/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/already have manage access here, through notebook:travel/i)).toBeInTheDocument()
  })

  it("shortens the grant to match the actor's own access rather than outliving it", async () => {
    const owner = await party()
    const admin = await party()
    const ada = await party()
    const held = await grant(owner, admin, {
      ability: "admin",
      depth: 2,
      resource: NOTEBOOK,
      expiresAt: T0 + 3 * DAY,
    })
    const onGrant = vi.fn().mockResolvedValue(undefined)

    render(
      <ShareDialog
        open
        onClose={vi.fn()}
        scopes={[{ resource: NOTEBOOK, label: "the notebook", covers: "Every note in it." }]}
        candidates={[person(ada.did, "Ada Lovelace")]}
        capabilities={[held]}
        context={contextOf(owner.did, [held])}
        actor={admin.did}
        onGrant={onGrant}
      />,
    )

    fireEvent.click(await screen.findByText("Ada Lovelace"))
    await waitFor(() =>
      expect(screen.getByText(/Shortened to match your own access/)).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /^Give read/ }))
    await waitFor(() => expect(onGrant).toHaveBeenCalled())
    const request = onGrant.mock.calls[0][0] as GrantRequest
    expect(request.expiresAt).toBe(T0 + 3 * DAY)
    expect(request.proof?.cid).toBe(held.cid)
  })

  it("refuses outright when the actor holds a non-delegable leaf", async () => {
    const owner = await party()
    const ada = await party()
    const bob = await party()
    const leaf = await grant(owner, ada, { ability: "write", depth: 0, resource: NOTEBOOK })

    render(
      <ShareDialog
        open
        onClose={vi.fn()}
        scopes={[{ resource: NOTEBOOK, label: "the notebook", covers: "Every note in it." }]}
        candidates={[person(bob.did, "Bob")]}
        capabilities={[leaf]}
        context={contextOf(owner.did, [leaf])}
        actor={ada.did}
        onGrant={vi.fn()}
      />,
    )

    expect(await screen.findByText("You cannot share this.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Give/ })).not.toBeInTheDocument()
  })
})

/* ---- the access list ----------------------------------------------------- */

describe("AccessList", () => {
  it("shows an inherited row as inherited, and names where it comes from", async () => {
    const owner = await party()
    const ada = await party()
    const wide = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })

    render(
      <AccessList
        capabilities={[wide]}
        resource={NOTE}
        resourceLabel="this note"
        context={contextOf(owner.did, [wide])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
        onRevoke={vi.fn()}
      />,
    )

    await screen.findByText("Ada Lovelace")
    expect(screen.getByText(/not granted on this note/)).toBeInTheDocument()
    expect(screen.getByText(NOTEBOOK)).toBeInTheDocument()
  })

  /**
   * The removal a plain confirm would get silently wrong: the grant conferring
   * access here is a notebook grant.
   */
  it("says that removing an inherited grant reaches the whole notebook", async () => {
    const owner = await party()
    const ada = await party()
    const wide = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })

    render(
      <AccessList
        capabilities={[wide]}
        resource={NOTE}
        resourceLabel="this note"
        context={contextOf(owner.did, [wide])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
        onRevoke={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: /Remove Ada Lovelace/ }))

    expect(screen.getByText(/takes away everything under it, not only this note/)).toBeInTheDocument()
    expect(screen.getByText(/they have already read, they keep/i)).toBeInTheDocument()
  })

  it("hands the caller every grant to withdraw, not only the strongest", async () => {
    const owner = await party()
    const ada = await party()
    const read = await grant(owner, ada, { ability: "read", resource: NOTE })
    const write = await grant(owner, ada, { ability: "write", resource: NOTE })
    const onRevoke = vi.fn().mockResolvedValue(undefined)

    render(
      <AccessList
        capabilities={[read, write]}
        resource={NOTE}
        resourceLabel="this note"
        context={contextOf(owner.did, [read, write])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
        onRevoke={onRevoke}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: /Remove Ada Lovelace/ }))
    expect(screen.getByText(/They hold 2 grants covering this note/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove access" }))
    await waitFor(() => expect(onRevoke).toHaveBeenCalled())
    expect((onRevoke.mock.calls[0][1] as RemovalPlan).revoke).toHaveLength(2)
  })

  it("disables removal the actor is not entitled to make", async () => {
    const owner = await party()
    const admin = await party()
    const ada = await party()
    const bystander = await party()
    const adminCap = await grant(owner, admin, { ability: "admin", depth: 2 })
    const adaCap = await grant(admin, ada, { ability: "write", proof: adminCap.cid })
    const all = [adminCap, adaCap]

    render(
      <AccessList
        capabilities={all}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, all)}
        actor={bystander.did}
        people={[person(ada.did, "Ada Lovelace"), person(admin.did, "Admin")]}
        onRevoke={vi.fn()}
      />,
    )

    await screen.findByText("Ada Lovelace")
    expect(screen.getByRole("button", { name: /Remove Ada Lovelace/ })).toBeDisabled()
  })

  it("marks a grant that can be passed on", async () => {
    const owner = await party()
    const ada = await party()
    const delegable = await grant(owner, ada, { ability: "admin", depth: 2, resource: NOTEBOOK })

    render(
      <AccessList
        capabilities={[delegable]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [delegable])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
      />,
    )

    await screen.findByText("Ada Lovelace")
    expect(screen.getByText(/can re-share/)).toBeInTheDocument()
  })

  it("offers a level change only on a direct grant, and calls back with the new level", async () => {
    const owner = await party()
    const ada = await party()
    const direct = await grant(owner, ada, { ability: "read", resource: NOTEBOOK })
    const onChangeLevel = vi.fn().mockResolvedValue(undefined)

    render(
      <AccessList
        capabilities={[direct]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [direct])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
        onChangeLevel={onChangeLevel}
        onRevoke={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: /Change level for Ada Lovelace/ }))
    expect(screen.getByText(/issues a new grant and withdraws the old one/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Can edit/))
    fireEvent.click(screen.getByRole("button", { name: "Save level" }))

    await waitFor(() => expect(onChangeLevel).toHaveBeenCalled())
    expect(onChangeLevel.mock.calls[0][1]).toBe("write")
  })

  it("shows the owner as unremovable rather than leaving them out", async () => {
    const owner = await party()

    render(
      <AccessList
        capabilities={[]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [])}
        actor={owner.did}
        people={[person(owner.did, "Sindre")]}
        onRevoke={vi.fn()}
      />,
    )

    const ownerRow = await screen.findByText("Sindre")
    expect(ownerRow).toBeInTheDocument()
    expect(screen.getByText(/cannot be removed/)).toBeInTheDocument()
    expect(screen.getByText(/Nobody else has access/)).toBeInTheDocument()
  })

  it("does not present an unresolved list as an empty one", async () => {
    const owner = await party()
    const ada = await party()
    const cap = await grant(owner, ada, { resource: NOTEBOOK })

    render(
      <AccessList
        capabilities={[cap]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [cap])}
        actor={owner.did}
      />,
    )

    expect(screen.getByText(/Checking who has access/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Checking who has access/)).not.toBeInTheDocument())
  })

  it("drops a row once its capability is revoked", async () => {
    const owner = await party()
    const ada = await party()
    const cap = await grant(owner, ada, { resource: NOTEBOOK })
    const revocation = await revokeCapability({
      signingKey: owner.key,
      issuer: owner.did,
      capabilityCid: cap.cid,
    })

    const { rerender } = render(
      <AccessList
        capabilities={[cap]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [cap])}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
      />,
    )
    await screen.findByText("Ada Lovelace")

    rerender(
      <AccessList
        capabilities={[cap]}
        resource={NOTEBOOK}
        resourceLabel="this notebook"
        context={contextOf(owner.did, [cap], { revoked: [revocation.cid] })}
        actor={owner.did}
        people={[person(ada.did, "Ada Lovelace")]}
      />,
    )

    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument())
  })
})

/* ---- the container ------------------------------------------------------- */

describe("SharingDialog", () => {
  async function setup() {
    const owner = await party()
    const ada = await party()
    const notebookCap = await grant(owner, ada, { ability: "write", resource: NOTEBOOK })
    const capabilities = [notebookCap]

    render(
      <SharingDialog
        open
        onClose={vi.fn()}
        scopes={[
          { resource: NOTE, label: "this note", covers: "Only this note." },
          {
            resource: NOTEBOOK,
            label: "the whole notebook",
            covers: "Every note in it, including ones added later.",
          },
        ]}
        capabilities={capabilities}
        context={contextOf(owner.did, capabilities)}
        actor={owner.did}
        candidates={[person(ada.did, "Ada Lovelace")]}
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />,
    )
    return { owner, ada }
  }

  /** Who can already see this is the question that decides whether to share. */
  it("shows who has access before offering to share, not behind a tab", async () => {
    await setup()

    await screen.findByText("Ada Lovelace")
    expect(screen.getByRole("button", { name: /Share this note/ })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: /^Share/ })).not.toBeInTheDocument()
  })

  it("switching scope changes what the list is about", async () => {
    await setup()
    await screen.findByText(/not granted on this note/)

    fireEvent.click(screen.getByRole("tab", { name: "the whole notebook" }))

    await waitFor(() =>
      expect(screen.getByText(/Granted on the whole notebook/)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/not granted on this note/)).not.toBeInTheDocument()
  })

  it("opens the share step already scoped to what is being looked at", async () => {
    await setup()
    await screen.findByText("Ada Lovelace")

    fireEvent.click(screen.getByRole("button", { name: /Share this note/ }))

    const dialog = await screen.findByRole("dialog", { name: /Share this note/ })
    expect(within(dialog).getByRole("radio", { name: /this note/ })).toBeChecked()
  })
})
