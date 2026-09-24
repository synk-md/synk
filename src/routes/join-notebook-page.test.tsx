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
  foundNotebookKeys,
  foundNotebookWorkspace,
  inviteToNotebook,
} from "@/lib/workspace"
import { createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"

import { JoinNotebookPage } from "./join-notebook-page"

// jsdom has no WebRTC, and a real provider reaches the public signaling servers
// over the network. The page's job here is the redemption, not the transport.
vi.mock("y-webrtc", () => ({
  WebrtcProvider: class {
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
      <Routes>
        <Route path="/join/:notebookId" element={<JoinNotebookPage />} />
      </Routes>
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
    mount()

    fireEvent.change(screen.getByLabelText("One-time code"), { target: { value: "nonsense" } })
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByLabelText("One-time code")).toBeEnabled()
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
