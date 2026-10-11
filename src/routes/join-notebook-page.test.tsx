import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { generateInvitationSecret, formatInvitationSecret } from "@/lib/directory"
import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import {
  createDeviceRecord,
  currentDevice,
  deviceFingerprint,
  didFromSigningKey,
  initCurrentDevice,
  resetCurrentDevice,
  resetDeviceIdentityCache,
  type DeviceIdentity,
} from "@/lib/identity"
import {
  admitFromRedemption,
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
  pendingRedemptions,
} from "@/lib/workspace"
import {
  createNotebookIndexDoc,
  evictNotebookIndexDoc,
  writeNotebookIndexTree,
} from "@/lib/yjs-utils"
import { NotebooksProvider } from "@/hooks/use-notebooks"

import { JoinNotebookPage } from "./join-notebook-page"
import { waitingMessage } from "./join-waiting-message"

// jsdom has no WebRTC, and a real provider reaches the public signaling servers
// over the network. The page's job here is the redemption, not the transport.
// Mirrors the real provider's surface, including the parts the page reads to
// explain itself: a fake that is missing them passes while the page throws.
vi.mock("y-webrtc", () => ({
  WebrtcProvider: class {
    signalingConns: { connected: boolean }[] = [{ connected: true }]
    on() {
      /* no peers ever arrive in a test */
    }
    off() {
      /* nothing was registered */
    }
    disconnect() {
      /* nothing to disconnect */
    }
    destroy() {
      /* nothing to release */
    }
  },
}))

let NOTEBOOK = "jointest"
let counter = 0

beforeEach(async () => {
  counter += 1
  NOTEBOOK = `jointest-${String(counter)}-${String(Date.now())}`
  evictNotebookIndexDoc(NOTEBOOK)
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
})

afterEach(cleanup)

/** Another browser's device, built from real keys. */
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

function mount() {
  render(
    <MemoryRouter initialEntries={[`/join/${NOTEBOOK}`]}>
      <NotebooksProvider>
        <Routes>
          <Route path="/join/:notebookId" element={<JoinNotebookPage />} />
        </Routes>
      </NotebooksProvider>
    </MemoryRouter>,
  )
}

/** An invitation waiting to be redeemed, issued by somebody else's device. */
async function anInvitation() {
  const owner = currentDevice()!
  const { doc, idb } = createNotebookIndexDoc(NOTEBOOK)
  await idb.whenSynced
  await foundNotebookWorkspace({
    doc,
    notebookId: NOTEBOOK,
    device: owner.identity,
    label: "Sindre",
  })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner.identity })

  const { secret } = generateInvitationSecret()
  await inviteToNotebook({
    doc,
    notebookId: NOTEBOOK,
    admin: { signingKey: owner.identity.signingKey, did: owner.identity.did },
    secret,
    label: "Ada",
  })
  return { doc, secret }
}

describe("the join page", () => {
  it("asks for the code, and says why the link alone is not enough", () => {
    mount()

    expect(screen.getByLabelText("One-time code")).toBeInTheDocument()
    expect(screen.getByText(/the link says\s+which notebook, the code proves it is you/)).toBeInTheDocument()
  })

  it("refuses a code that is not a valid secret", async () => {
    await anInvitation()
    mount()

    // Gated until the notebook has arrived, so wait for that first.
    const submit = await screen.findByRole("button", { name: "Ask to join" })
    fireEvent.change(screen.getByLabelText("One-time code"), { target: { value: "nonsense" } })
    fireEvent.click(submit)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByLabelText("One-time code")).toBeEnabled()
  })

  /**
   * A code checked against a document that has not arrived always fails, and
   * reporting that as a wrong code sends somebody off to re-check a code that
   * was right all along.
   */
  it("will not check a code before the notebook has reached this device", () => {
    mount()

    expect(screen.getByRole("button", { name: /Waiting for the notebook/ })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent(/Connecting to the notebook/)
  })

  it("stops waiting once the notebook arrives", async () => {
    const { secret } = await anInvitation()
    mount()

    // The label stops saying it is waiting...
    await screen.findByRole("button", { name: "Ask to join" })
    expect(screen.queryByText(/Connecting to the notebook/)).not.toBeInTheDocument()

    // ...and a typed code can now be submitted.
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    expect(screen.getByRole("button", { name: "Ask to join" })).toBeEnabled()
  })

  /**
   * The owner is asked to compare a code against what this screen shows. If it
   * showed nothing, the check they are making would be theatre.
   */
  it("shows this device's code once the request is sent", async () => {
    const { secret } = await anInvitation()
    mount()

    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    await screen.findByText("Waiting to be let in")

    const expected = await deviceFingerprint(currentDevice()!.identity.did)
    await waitFor(() => {
      expect(screen.getByLabelText("Your device code")).toHaveTextContent(expected)
    })
  })

  it("says to read the code out by a different route than the link came by", async () => {
    const { secret } = await anInvitation()
    mount()

    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    await screen.findByText("Waiting to be let in")
    expect(screen.getByText(/not in the\s+same place you were sent the link/)).toBeInTheDocument()
    expect(screen.getByText(/they are not talking to you and should refuse/)).toBeInTheDocument()
  })

  it("records the redemption in the notebook's document", async () => {
    const { doc, secret } = await anInvitation()
    mount()

    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    await waitFor(() => {
      expect(doc.getMap("directory:redemptions").size).toBe(1)
    })
  })
})

describe("checking who owns the notebook", () => {
  /** The code names an invitation; the invitation names the admin who signed it. */
  it("refuses a code that matches no invitation here", async () => {
    await anInvitation()
    const { secret: unrelated } = generateInvitationSecret()
    mount()

    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(unrelated) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not match an invitation to this notebook/,
    )
  })

  /**
   * A notebook naming a different owner than the invitation's signer is a
   * disagreement, and continuing would be trust-on-first-use in whatever
   * document turned up.
   */
  it("refuses when the notebook disagrees with the invitation about its owner", async () => {
    const { doc, secret } = await anInvitation()

    // The genesis is replaced by one nobody invited anybody on behalf of.
    const impostor = await anotherDevice()
    doc.getMap("workspace:genesis").clear()
    const { createGenesis, putGenesis, workspaceIdFor, resourceIdFor } = await import(
      "@/lib/workspace"
    )
    putGenesis(
      doc,
      await createGenesis({
        signingKey: impostor.signingKey,
        owner: impostor.did,
        workspace: workspaceIdFor(NOTEBOOK),
        resource: resourceIdFor(NOTEBOOK),
      }),
    )

    mount()
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not agree about who owns it/)
    // And nothing was published into a notebook it does not trust.
    expect(doc.getMap("directory:redemptions").size).toBe(0)
  })
})

/* ---- why nothing has arrived ---------------------------------------------- */

describe("waitingMessage", () => {
  const state = (over: Partial<Parameters<typeof waitingMessage>[0]> = {}) =>
    waitingMessage({ waitedTooLong: true, signaling: true, peers: 1, ...over })

  it("does not diagnose anything while the wait is still ordinary", () => {
    expect(state({ waitedTooLong: false, signaling: false, peers: 0 })).toMatch(/Connecting/)
  })

  /** The failure that presented as a wrong code, and then as a dead spinner. */
  it("blames unreachable signaling rather than the person waiting", () => {
    const message = state({ signaling: false, peers: 0 })
    expect(message).toMatch(/cannot reach the service/)
    expect(message).toMatch(/Nothing you can do from here/)
  })

  it("says nobody is here when signaling works but no peer is found", () => {
    expect(state({ peers: 0 })).toMatch(/nobody else is in this notebook/)
  })

  it("distinguishes a connected peer from a missing one", () => {
    expect(state({ peers: 1 })).toMatch(/Still waiting for the notebook itself/)
  })

  /** Unreachable signaling outranks an empty room: it explains the empty room. */
  it("reports the cause, not the symptom, when both are true", () => {
    expect(state({ signaling: false, peers: 0 })).toMatch(/cannot reach the service/)
  })
})

/* ---- being let in --------------------------------------------------------- */

describe("being let in", () => {
  /**
   * The editor resolves `/nb/:id` against this device's own notebook list and
   * sends anything missing to 404, so a member could hold the keys and still
   * have nowhere to go.
   *
   * Unlike the tests above, the owner here is a different device: this device
   * has to be somebody the owner admits, not the owner.
   */
  it("adds the notebook to this device's own list", async () => {
    localStorage.removeItem("notebooks:v1")
    const owner = await anotherDevice()
    const handle = createNotebookIndexDoc(NOTEBOOK)
    const { doc } = handle
    await handle.idb.whenSynced
    await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: owner, label: "Sindre" })
    await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: owner })

    const { secret } = generateInvitationSecret()
    const invitation = await inviteToNotebook({
      doc,
      notebookId: NOTEBOOK,
      admin: { signingKey: owner.signingKey, did: owner.did },
      secret,
      label: "Ada",
    })

    // The owner's tree is what there is to adopt.
    writeNotebookIndexTree(handle, new Map(), {
      id: `root_${NOTEBOOK}`,
      name: "Trip planning",
      isFolder: true,
      children: [{ id: "note_1", name: "Flights", isFolder: false }],
    }, "owner-seed")

    mount()
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: formatInvitationSecret(secret) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))
    await waitFor(() => {
      expect(pendingRedemptions(doc)).toHaveLength(1)
    })

    // The separate act by the separate person.
    await admitFromRedemption({
      doc,
      notebookId: NOTEBOOK,
      owner,
      invitation,
      redemption: pendingRedemptions(doc)[0],
    })

    expect(await screen.findByText("You are in.")).toBeInTheDocument()

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("notebooks:v1") ?? "{}") as {
        notebooks?: { id: string; name: string; root: { name: string } }[]
      }
      const adopted = stored.notebooks?.find((nb) => nb.id === NOTEBOOK)
      expect(adopted).toBeDefined()
      // Under the notebook's own id, carrying the owner's tree: a fresh id
      // would point the editor at a notebook nobody else has.
      expect(adopted?.root.name).toBe("Trip planning")
    })

    // And only now is there somewhere to go.
    expect(screen.getByText("Open the notebook")).toHaveAttribute("href", `/nb/${NOTEBOOK}`)
  }, 20_000)
})
