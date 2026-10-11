import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import * as Y from "yjs"

import { createNotebookIndexDoc } from "@/lib/yjs-utils"
import type { Notebook, TreeNode } from "./tree"
import { useNotebookFileSystem } from "./use-notebook-filesystem"

const { providerInstances, FakeWebrtcProvider } = vi.hoisted(() => {
  class FakeWebrtcProvider {
    roomName: string
    doc: Y.Doc
    disconnect = vi.fn()
    destroy = vi.fn()
    constructor(roomName: string, doc: Y.Doc) {
      this.roomName = roomName
      this.doc = doc
      providerInstances.push(this)
    }
  }
  const providerInstances: InstanceType<typeof FakeWebrtcProvider>[] = []
  return { providerInstances, FakeWebrtcProvider }
})

vi.mock("y-webrtc", () => ({ WebrtcProvider: FakeWebrtcProvider }))

// A relay is configured. What it does is tested with the replicas; this file
// is about what is left for the WebRTC rooms to carry.
vi.mock("@/hooks/use-notebook-replication", () => ({
  useNotebookReplication: () => ({ relay: true, directory: "live", tree: "off", treeStatus: "offline" }),
}))

let counter = 0
function aNotebook(): Notebook {
  counter += 1
  const id = `relayed-${String(counter)}-${String(Date.now())}`
  const root: TreeNode = { id: "root", name: "root", isFolder: true, children: [] }
  return { id, name: id, root, createdAt: Date.now() }
}

async function mounted(nb: Notebook) {
  const hook = renderHook(() => useNotebookFileSystem(nb, vi.fn(), { replicate: true }))
  await waitFor(() => expect(hook.result.current.treeReady).toBe(true))
  return hook
}

function admitSomeone(id: string) {
  const handle = createNotebookIndexDoc(id)
  act(() => {
    const admissions = handle.doc.getMap("directory:admissions")
    admissions.set("did:key:zOwner", { member: "member:owner" })
    admissions.set("did:key:zAda", { member: "member:ada" })
  })
}

beforeEach(() => {
  providerInstances.length = 0
})

describe("useNotebookFileSystem with a relay", () => {
  /** Titles go through the relay, sealed. The room is only for cursors. */
  it("gives members a presence room that carries no part of the tree", async () => {
    const nb = aNotebook()
    const { result } = await mounted(nb)
    admitSomeone(nb.id)

    await waitFor(() => expect(result.current.sharedWithMembers).toBe(true))
    expect(providerInstances.map((provider) => provider.roomName)).toEqual([`nb:${nb.id}:index:presence`])
    const handle = createNotebookIndexDoc(nb.id)
    expect(providerInstances[0].doc).not.toBe(handle.tree)
    expect(providerInstances[0].doc).not.toBe(handle.doc)
    expect(result.current.indexProvider).toBe(providerInstances[0])
  })

  /** A link is readable by whoever holds it, so link guests still get the tree. */
  it("keeps the tree room for a link-shared notebook, without the directory", async () => {
    const nb = aNotebook()
    const { result } = await mounted(nb)
    act(() => {
      result.current.setLinkAccess?.("view")
    })

    await waitFor(() => expect(providerInstances).toHaveLength(1))
    expect(providerInstances[0].roomName).toBe(`nb:${nb.id}:index`)
    expect(providerInstances[0].doc).toBe(createNotebookIndexDoc(nb.id).tree)
  })

  /** The invitation and the redemption wait at the relay instead. */
  it("opens nothing for an invitation", async () => {
    const nb = aNotebook()
    await mounted(nb)
    const handle = createNotebookIndexDoc(nb.id)
    act(() => {
      handle.doc.getMap("directory:invitations").set("did:key:zInvite", {
        invitationId: "did:key:zInvite",
        expiresAt: Date.now() + 60_000,
        issuedAt: Date.now(),
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(providerInstances).toHaveLength(0)
  })

  it("opens nothing for a notebook only its founder holds", async () => {
    await mounted(aNotebook())
    expect(providerInstances).toHaveLength(0)
  })
})
