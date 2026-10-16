import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import * as Y from "yjs"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { putAdmission, putDeviceRecord } from "@/lib/directory"
import {
  createDeviceAdmission,
  createDeviceRecord,
  didFromSigningKey,
  type DeviceIdentity,
} from "@/lib/identity"
import {
  createGenesis,
  foundNotebookWorkspace,
  memberIdFor,
  putGenesis,
  readNotebookWorkspace,
  resourceIdFor,
  workspaceIdFor,
  type NotebookWorkspace,
} from "@/lib/workspace"

import { WorkspacePanel } from "./workspace-panel"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"

afterEach(cleanup)

async function aDevice(): Promise<DeviceIdentity> {
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

async function founded(): Promise<{ doc: Y.Doc; owner: DeviceIdentity }> {
  const doc = new Y.Doc()
  const owner = await aDevice()
  await foundNotebookWorkspace({
    doc,
    notebookId: NOTEBOOK,
    device: owner,
    label: "Maren",
    createdAt: T0,
  })
  return { doc, owner }
}

function read(doc: Y.Doc, selfDid?: string): Promise<NotebookWorkspace> {
  return readNotebookWorkspace({
    doc,
    notebookId: NOTEBOOK,
    now: T0,
    ...(selfDid === undefined ? {} : { selfDid }),
  })
}

describe("WorkspacePanel", () => {
  it("names the owner and lists the members", async () => {
    const { doc, owner } = await founded()
    render(<WorkspacePanel workspace={await read(doc, owner.did)} selfDid={owner.did} />)

    // The name appears as the owner line and again as the member row.
    expect(screen.getAllByText("Maren")).toHaveLength(2)
    expect(screen.getByText(/Owned by/)).toBeInTheDocument()
    expect(screen.getByText("1 member")).toBeInTheDocument()
    expect(screen.getByText("This device")).toBeInTheDocument()
  })

  /**
   * The member list is read against the owner as the only trusted admin, so
   * without an owner there is no list to show rather than an unverified one.
   */
  it("hides the member list when two devices both claim ownership", async () => {
    const { doc } = await founded()
    const attacker = await aDevice()
    putGenesis(
      doc,
      await createGenesis({
        signingKey: attacker.signingKey,
        owner: attacker.did,
        workspace: workspaceIdFor(NOTEBOOK),
        resource: resourceIdFor(NOTEBOOK),
        createdAt: T0,
      }),
    )

    render(<WorkspacePanel workspace={await read(doc)} />)

    expect(screen.getByRole("alert")).toHaveTextContent(/both claim to own/)
    expect(screen.queryByRole("list", { name: "Members" })).not.toBeInTheDocument()
  })

  it("says plainly that an older notebook has no owner", async () => {
    render(<WorkspacePanel workspace={await read(new Y.Doc())} />)

    expect(screen.getByText("This notebook has no recorded owner.")).toBeInTheDocument()
    expect(screen.getByText(/Everything still works/)).toBeInTheDocument()
  })

  it("reports records that failed verification instead of quietly shortening the list", async () => {
    const { doc, owner } = await founded()
    // Well formed, and altered after it was signed.
    const attacker = await aDevice()
    doc.getMap("directory:devices").set("did:key:zNotThisOne", { ...attacker.record, createdAt: attacker.record.createdAt + 1 })

    render(<WorkspacePanel workspace={await read(doc, owner.did)} />)

    expect(screen.getByText(/1 record was dropped for failing/)).toBeInTheDocument()
  })

  it("shows a member admitted by the owner", async () => {
    const { doc, owner } = await founded()
    const colleague = await aDevice()
    putDeviceRecord(doc, colleague.record)
    putAdmission(
      doc,
      await createDeviceAdmission({
        adminSigningKey: owner.signingKey,
        adminDid: owner.did,
        record: colleague.record,
        member: memberIdFor(colleague.did),
        label: "Ada",
        workspace: workspaceIdFor(NOTEBOOK),
        issuedAt: T0,
      }),
    )

    render(<WorkspacePanel workspace={await read(doc, owner.did)} selfDid={owner.did} />)

    expect(screen.getByText("2 members")).toBeInTheDocument()
    expect(screen.getByText("Ada")).toBeInTheDocument()
    // An admission is not a verified identity.
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0)
  })

  it("says it is still checking rather than showing an empty workspace", () => {
    render(<WorkspacePanel workspace={null} loading />)
    expect(screen.getByRole("status")).toHaveTextContent(/Checking who this notebook belongs to/)
  })
})
