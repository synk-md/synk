import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import {
  createDeviceRecord,
  currentDevice,
  didFromSigningKey,
  initCurrentDevice,
  resetCurrentDevice,
  resetDeviceIdentityCache,
  type DeviceIdentity,
} from "@/lib/identity"
import { getNotebookLinkAccess } from "@/lib/notebook-meta"
import {
  admitFromRedemption,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  readNotebookKeys,
  readNotebookWorkspace,
  redeemIntoNotebook,
} from "@/lib/workspace"
import { createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"

import { ShareAccessDialog, type ShareAccessDialogProps } from "./share-access-dialog"

/**
 * A fresh id per test. `evictNotebookIndexDoc` drops the in-memory handle but
 * the stored document survives, so reusing one id leaks a previous test's
 * genesis into the next and the notebook comes back disputed.
 */
let NOTEBOOK = "sharetest"
let counter = 0

beforeEach(async () => {
  counter += 1
  NOTEBOOK = `sharetest-${String(counter)}-${String(Date.now())}`
  evictNotebookIndexDoc(NOTEBOOK)
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(cleanup)

/** Another browser's device: genuinely different keys, or the test proves nothing. */
async function anotherDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** The notebook as the app creates one: owned by this device, with a key domain. */
async function ownedNotebook() {
  const device = currentDevice()!
  const { doc, idb } = createNotebookIndexDoc(NOTEBOOK)
  await idb.whenSynced
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: device.identity, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: device.identity })
  return { doc, device }
}

async function withAda() {
  const { doc, device } = await ownedNotebook()
  const ada = await anotherDevice()
  const { secret } = generateInvitationSecret()
  const invitation = await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin: device.identity, secret, label: "Ada" })
  const redemption = await redeemIntoNotebook({ doc, secret, device: ada })
  await admitFromRedemption({ doc, notebookId: NOTEBOOK, owner: device.identity, invitation, redemption, ability: "write" })
  return { doc, device, ada }
}

function mount(props: Partial<ShareAccessDialogProps> = {}) {
  render(
    <ShareAccessDialog
      open
      onClose={vi.fn()}
      notebookId={NOTEBOOK}
      notebookName="Travel"
      joinLinkFor={(id) => `https://synk.test/join/${id}`}
      {...props}
    />,
  )
}

const aNote = (overrides: Partial<NonNullable<ShareAccessDialogProps["note"]>> = {}) => ({
  id: "kyoto",
  linkAccess: "restricted" as const,
  onLinkAccessChange: vi.fn(),
  ...overrides,
})

describe("people", () => {
  it("shows the owner as the only member of a fresh notebook", async () => {
    await ownedNotebook()
    mount()

    expect(await screen.findByText("1 member")).toBeInTheDocument()
    expect(await screen.findByText("Maren")).toBeInTheDocument()
    expect(screen.getByText("you")).toBeInTheDocument()
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
    await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: other, label: "Someone else" })
    await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: other })
    mount()

    expect(await screen.findByText(/Only the notebook's owner/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Invite someone/ })).not.toBeInTheDocument()
  })

  it("publishes an invitation through the create flow", async () => {
    const { doc } = await ownedNotebook()
    mount()

    fireEvent.click(await screen.findByRole("button", { name: /Invite someone/ }))
    fireEvent.change(await screen.findByLabelText("Their name"), { target: { value: "Ada Lovelace" } })
    fireEvent.click(screen.getByRole("button", { name: /Create invitation/ }))

    await waitFor(() => expect(doc.getMap("directory:invitations").size).toBe(1))
    // The link is offered; the secret is not in it.
    expect((await screen.findByLabelText("Joining link")).textContent).toBe(`https://synk.test/join/${NOTEBOOK}`)
  })

  it("lists a request as waiting, and lets them in end to end", async () => {
    const { doc, device } = await ownedNotebook()
    const { secret } = generateInvitationSecret()
    await inviteToNotebook({ doc, notebookId: NOTEBOOK, admin: device.identity, secret, label: "Ada Lovelace" })
    const joiner = await anotherDevice()
    await redeemIntoNotebook({ doc, secret, device: joiner })
    mount()

    expect(await screen.findByText("Waiting for you")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Review" }))
    const dialog = await screen.findByRole("dialog", { name: /Let them in/ })
    const code = within(dialog).getByLabelText("Expected fingerprint").textContent ?? ""
    fireEvent.change(within(dialog).getByLabelText("Type it here to confirm"), { target: { value: code } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Admit" }))

    expect(await screen.findByText("2 members", {}, { timeout: 10_000 })).toBeInTheDocument()
    const workspace = await readNotebookWorkspace({ doc, notebookId: NOTEBOOK })
    const keys = await readNotebookKeys({ doc, notebookId: NOTEBOOK, device: joiner, owner: workspace.ownership.owner })
    expect(keys.access).toBe("reader")
  }, 20_000)

  /** Removing someone's notebook access is removing them, keys and all. */
  it("takes someone out of the notebook when their access is removed", async () => {
    const { doc, device, ada } = await withAda()
    mount()

    expect(await screen.findByText("2 members")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove Maren" })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Remove Ada" }))
    fireEvent.click(await screen.findByRole("button", { name: "Remove access" }))

    expect(await screen.findByText("1 member", {}, { timeout: 10_000 })).toBeInTheDocument()
    const keys = await readNotebookKeys({ doc, notebookId: NOTEBOOK, device: ada, owner: device.identity.did })
    expect(keys.current).toBe(false)
  }, 20_000)
})

describe("one switch for what is being shared", () => {
  it("opens on the note, and moves people and link together to the notebook", async () => {
    await withAda()
    mount({ note: aNote() })

    expect(await screen.findByRole("heading", { name: "Share this note" })).toBeInTheDocument()
    expect(await screen.findByText(/Granted on|Through/)).toBeInTheDocument()
    expect(screen.getByRole("radiogroup", { name: "Link to this note" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Whole notebook" }))
    expect(screen.getByRole("heading", { name: "Share “Travel”" })).toBeInTheDocument()
    expect(screen.getByRole("radiogroup", { name: "Link to Travel" })).toBeInTheDocument()
  }, 20_000)

  it("has no note to switch to when opened for a notebook", async () => {
    await ownedNotebook()
    mount()

    expect(await screen.findByRole("heading", { name: "Share “Travel”" })).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })
})

describe("a link for anyone", () => {
  it("turns the note's link on through the editor, and says it is not end-to-end encrypted", async () => {
    await ownedNotebook()
    const onLinkAccessChange = vi.fn()
    const { rerender } = render(
      <ShareAccessDialog
        open
        onClose={vi.fn()}
        notebookId={NOTEBOOK}
        notebookName="Travel"
        note={aNote({ onLinkAccessChange })}
        joinLinkFor={(id) => `https://synk.test/join/${id}`}
      />,
    )

    fireEvent.click(await screen.findByLabelText("Anyone with the link can read"))
    expect(onLinkAccessChange).toHaveBeenCalledWith("view")

    rerender(
      <ShareAccessDialog
        open
        onClose={vi.fn()}
        notebookId={NOTEBOOK}
        notebookName="Travel"
        note={aNote({ linkAccess: "view", onLinkAccessChange })}
        joinLinkFor={(id) => `https://synk.test/join/${id}`}
      />,
    )
    expect(screen.getByLabelText("Link to copy")).toHaveValue(`${window.location.origin}/s/${NOTEBOOK}/kyoto`)
    expect(screen.getByText(/readable by whoever holds it/)).toBeInTheDocument()
  })

  it("sets the notebook's own link on its scope", async () => {
    await ownedNotebook()
    mount()

    fireEvent.click(await screen.findByLabelText("Anyone with the link can edit"))
    expect(getNotebookLinkAccess(createNotebookIndexDoc(NOTEBOOK).meta)).toBe("edit")
    expect(screen.getByLabelText("Link to copy")).toHaveValue(`${window.location.origin}/s/${NOTEBOOK}`)
  })
})

describe("viewing now", () => {
  it("lists who has the note open, on the note only", async () => {
    await ownedNotebook()
    mount({ note: aNote(), viewers: [{ id: "1", name: "Ada", active: true }] })

    expect(await screen.findByRole("heading", { name: "Viewing now" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Whole notebook" }))
    expect(screen.queryByRole("heading", { name: "Viewing now" })).not.toBeInTheDocument()
  })
})
