import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import {
  createDeviceRecord,
  didFromSigningKey,
  initCurrentDevice,
  resetCurrentDevice,
  resetDeviceIdentityCache,
  currentDevice,
  type DeviceIdentity,
} from "@/lib/identity"
import {
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  readNotebookKeys,
  readNotebookWorkspace,
  redeemIntoNotebook,
} from "@/lib/workspace"
import { createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"

import { NotebookMembersDialog } from "./notebook-members-dialog"

/**
 * A fresh id per test. `evictNotebookIndexDoc` drops the in-memory handle but
 * the stored document survives, so reusing one id leaks a previous test's
 * genesis into the next and the notebook comes back disputed.
 */
let NOTEBOOK = "memtest"
let counter = 0

beforeEach(async () => {
  counter += 1
  NOTEBOOK = `memtest-${String(counter)}-${String(Date.now())}`
  evictNotebookIndexDoc(NOTEBOOK)
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(cleanup)

/**
 * Another browser's device. Built from raw keys rather than by resetting the
 * global identity, which reloads the same one from storage - the joiner has to
 * be genuinely different keys or the test proves nothing.
 */
async function anotherDevice(): Promise<DeviceIdentity> {
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

/** The notebook as the app creates one: owned, with a key domain. */
async function ownedNotebook() {
  const device = currentDevice()!
  const { doc, idb } = createNotebookIndexDoc(NOTEBOOK)
  await idb.whenSynced
  await foundNotebookWorkspace({
    doc,
    notebookId: NOTEBOOK,
    device: device.identity,
    label: "Sindre",
  })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: device.identity })
  return { doc, device }
}

function mount() {
  render(
    <NotebookMembersDialog
      open
      onClose={vi.fn()}
      notebookId={NOTEBOOK}
      joinLinkFor={(id) => `https://synk.test/join/${id}`}
    />,
  )
}

describe("the notebook members dialog", () => {
  it("shows the owner as the only member of a fresh notebook", async () => {
    await ownedNotebook()
    mount()

    expect(await screen.findByText("1 member")).toBeInTheDocument()
    expect(screen.getAllByText("Sindre").length).toBeGreaterThan(0)
    expect(screen.getByText("This device")).toBeInTheDocument()
  })

  it("offers inviting to the owner", async () => {
    await ownedNotebook()
    mount()

    expect(await screen.findByRole("button", { name: /Invite someone/ })).toBeInTheDocument()
  })

  /** The grant is admin-gated in the library, and the interface agrees with it. */
  it("does not offer inviting on a notebook this device does not own", async () => {
    const { doc, idb } = createNotebookIndexDoc(NOTEBOOK)
    await idb.whenSynced
    const other = await anotherDevice()
    await foundNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      device: other,
      label: "Someone else",
    })
    await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: other })

    mount()

    expect(
      await screen.findByText(/Only the person who created this notebook/),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Invite someone/ })).not.toBeInTheDocument()
  })

  it("publishes an invitation through the create flow", async () => {
    const { doc } = await ownedNotebook()
    mount()

    fireEvent.click(await screen.findByRole("button", { name: /Invite someone/ }))
    fireEvent.change(await screen.findByLabelText("Their name"), {
      target: { value: "Ada Lovelace" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Create invitation/ }))

    await waitFor(() => {
      expect(doc.getMap("directory:invitations").size).toBe(1)
    })
    // The link is offered; the secret is not in it.
    const link = await screen.findByLabelText("Joining link")
    expect(link.textContent).toBe(`https://synk.test/join/${NOTEBOOK}`)
  })

  it("lists a redemption as waiting, and admits it end to end", async () => {
    const { doc, device } = await ownedNotebook()
    const { secret } = generateInvitationSecret()
    await inviteToNotebook({
      doc,
      notebookId: NOTEBOOK,
      admin: { signingKey: device.identity.signingKey, did: device.identity.did },
      secret,
      label: "Ada Lovelace",
    })

    // A second device redeems, as the join page would.
    const joiner = await anotherDevice()
    await redeemIntoNotebook({ doc, secret, device: joiner })

    mount()

    expect(await screen.findByText("Waiting for you")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Review" }))

    // Admit is gated on the fingerprint being typed, so this is the real flow.
    const dialog = await screen.findByRole("dialog", { name: /Let them in/ })
    const code = within(dialog).getByLabelText("Expected fingerprint").textContent ?? ""
    fireEvent.change(within(dialog).getByLabelText("Type it here to confirm"), {
      target: { value: code },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Admit" }))

    // Two: the owner's own, plus the one just granted. Waiting for 1 would
    // have been satisfied before the grant even ran.
    await waitFor(() => {
      expect(doc.getMap("directory:admissions").size).toBe(2)
    })

    // Identity, keys and authority all landed.
    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK })
    expect(workspace.users).toHaveLength(2)

    const keys = await readNotebookKeys({
      doc,
      notebookId: NOTEBOOK,
      device: joiner,
      owner: workspace.ownership.owner,
    })
    expect(keys.access).toBe("reader")
  }, 20_000)

  it("stops showing a redemption once it has been admitted", async () => {
    const { doc, device } = await ownedNotebook()
    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc,
      notebookId: NOTEBOOK,
      admin: { signingKey: device.identity.signingKey, did: device.identity.did },
      secret,
      label: "Ada",
    })

    const joiner = await anotherDevice()
    const redemption = await redeemIntoNotebook({ doc, secret, device: joiner })

    const { admitFromRedemption } = await import("@/lib/workspace")
    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner: device.identity,
      invitation,
      redemption,
    })

    mount()

    expect(await screen.findByText("2 members")).toBeInTheDocument()
    expect(screen.queryByText("Waiting for you")).not.toBeInTheDocument()
  }, 20_000)
})
