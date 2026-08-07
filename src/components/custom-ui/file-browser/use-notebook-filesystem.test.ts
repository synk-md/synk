import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useNotebookFileSystem } from "./use-notebook-filesystem"
import { createNotebookIndexDoc, readNotebookIndexTree } from "@/lib/yjs-utils"
import { flattenTree, type Notebook, type TreeNode } from "./tree"

// The index doc's Yjs storage is one node per Yjs map entry (see
// yjs-utils.ts), not a single tree blob — seed/inspect it through this
// helper rather than writing a whole tree into one key directly.
function seedIndexNodes(indexHandle: ReturnType<typeof createNotebookIndexDoc>, root: TreeNode) {
  const flat = flattenTree(root)
  indexHandle.doc.transact(() => {
    for (const [id, record] of flat) indexHandle.nodes.set(id, record)
  })
}

// Mirrors use-background-note-sync.test.ts: a stand-in for y-webrtc's
// WebrtcProvider that records construction and exposes disconnect/destroy
// spies, so tests can assert on connection lifecycle without real networking.
const { providerInstances, FakeWebrtcProvider } = vi.hoisted(() => {
  class FakeWebrtcProvider {
    roomName: string
    doc: Y.Doc
    opts: unknown
    disconnect = vi.fn()
    destroy = vi.fn()
    constructor(roomName: string, doc: Y.Doc, opts: unknown) {
      this.roomName = roomName
      this.doc = doc
      this.opts = opts
      providerInstances.push(this)
    }
  }
  const providerInstances: InstanceType<typeof FakeWebrtcProvider>[] = []
  return { providerInstances, FakeWebrtcProvider }
})

vi.mock("y-webrtc", () => ({ WebrtcProvider: FakeWebrtcProvider }))

function note(id: string): TreeNode {
  return { id, name: id, isFolder: false }
}

function folder(id: string, children: TreeNode[] = []): TreeNode {
  return { id, name: id, isFolder: true, children }
}

function notebook(id: string, root: TreeNode): Notebook {
  return { id, name: id, root, createdAt: Date.now() }
}

let idCounter = 0
function uniqueNotebookId(): string {
  idCounter += 1
  return `nb-${idCounter}-${Date.now()}`
}

beforeEach(() => {
  providerInstances.length = 0
})

// Real timers by default: waitFor() below polls via real setTimeout/rAF, so
// it hangs forever under fake timers. Only the grace-window tests (which
// drive time explicitly via vi.advanceTimersByTimeAsync) opt into fake ones.
afterEach(() => {
  vi.useRealTimers()
})

describe("useNotebookFileSystem: mounting with no notebook", () => {
  it("does nothing when notebook is null", () => {
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(null, updateNotebookRoot))

    expect(result.current.linkAccess).toBe("restricted")
    expect(result.current.indexProvider).toBeNull()
    expect(updateNotebookRoot).not.toHaveBeenCalled()
  })
})

describe("useNotebookFileSystem: seeding and adopting the persisted tree", () => {
  it("seeds the index doc with the notebook's root when nothing is persisted (seedIfEmpty default)", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()

    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    const indexHandle = createNotebookIndexDoc(id)

    // treeReady defaults to true immediately (safe-by-default for a fresh,
    // unshared notebook - see seedIfEmpty's doc comment), so it doesn't
    // signal that the async seed write has landed; wait on that directly.
    await waitFor(() => expect(readNotebookIndexTree(indexHandle).root).toEqual(nb.root))
    expect(result.current.tree).toEqual(nb.root)
  })

  it("adopts an already-persisted root instead of the notebook's own root", async () => {
    const id = uniqueNotebookId()
    const persistedRoot = folder("root", [note("persisted-note")])
    // Priming through the same cached doc the hook itself will read from.
    const primed = createNotebookIndexDoc(id)
    seedIndexNodes(primed, persistedRoot)

    const nb = notebook(id, folder("root", [note("notebook-own-note")]))
    const updateNotebookRoot = vi.fn()

    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))

    await waitFor(() => expect(result.current.tree).toEqual(persistedRoot))
    expect(updateNotebookRoot).toHaveBeenCalledWith(id, persistedRoot)
  })

  it("adopts a root that arrives from a peer mid-session (via the tree observer)", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    const peerRoot = folder("root", [note("a"), note("from-peer")])
    act(() => {
      seedIndexNodes(createNotebookIndexDoc(id), peerRoot)
    })

    expect(result.current.tree).toEqual(peerRoot)
  })

  // Regression test for the actual bug this rework fixes: the index used to
  // be a single Yjs map key holding the whole tree as one JSON blob, so a
  // peer's concurrent write didn't merge - it replaced the local tree
  // outright, silently deleting whatever notes only existed on the losing
  // side (e.g. new notes created while offline, wiped out the moment the
  // notebook reconnected and synced with a peer). Now each node is its own
  // map entry, so a peer adding one note and the local session adding a
  // different one both survive.
  it("merges a peer's concurrently-added node with a local one instead of one replacing the other", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    const indexHandle = createNotebookIndexDoc(id)
    await waitFor(() => expect(readNotebookIndexTree(indexHandle).root).toEqual(nb.root))

    // Local session creates a new note (e.g. made while offline).
    act(() => {
      result.current.createNode("root", { id: "local-new", name: "local-new", isFolder: false })
    })
    await waitFor(() => {
      expect(readNotebookIndexTree(indexHandle).flat.has("local-new")).toBe(true)
    })

    // A peer, unaware of the local addition, concurrently added its own
    // note under the same folder - simulated by writing directly to the
    // shared nodes map rather than through this hook's diffing path.
    act(() => {
      indexHandle.nodes.set("peer-new", { parentId: "root", name: "peer-new", isFolder: false })
    })

    await waitFor(() => {
      const ids = (result.current.tree.children ?? []).map((c) => c.id)
      expect(ids).toEqual(expect.arrayContaining(["a", "local-new", "peer-new"]))
    })
  })

  it("with seedIfEmpty=false, waits for the grace window before treating an empty index as authoritative", async () => {
    vi.useFakeTimers()
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()
    const options = { seedIfEmpty: false }
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot, options))

    // Not ready yet: still within the grace window, nothing persisted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.treeReady).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(result.current.treeReady).toBe(true)
  })

  it("with seedIfEmpty=false, a root arriving before the grace window ends short-circuits it", async () => {
    vi.useFakeTimers()
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()
    const options = { seedIfEmpty: false }
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot, options))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.treeReady).toBe(false)

    const peerRoot = folder("root", [note("from-peer-early")])
    act(() => {
      seedIndexNodes(createNotebookIndexDoc(id), peerRoot)
    })

    expect(result.current.treeReady).toBe(true)
    expect(result.current.tree).toEqual(peerRoot)
  })
})

describe("useNotebookFileSystem: link access", () => {
  it("starts at the optimistic default and adopts a persisted value once observed", async () => {
    const id = uniqueNotebookId()
    const primed = createNotebookIndexDoc(id)
    primed.meta.set("linkAccess", "edit")

    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))

    expect(result.current.linkAccess).toBe("edit")
  })

  it("respects a custom optimisticLinkAccess before anything is known", () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const options = { optimisticLinkAccess: "view" as const }
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot, options))

    expect(result.current.linkAccess).toBe("view")
  })

  it("setLinkAccess writes through to the notebook's meta map and is reflected back", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    act(() => {
      result.current.setLinkAccess?.("edit")
    })

    expect(result.current.linkAccess).toBe("edit")
  })
})

describe("useNotebookFileSystem: WebRTC provider gating", () => {
  it("does not connect a provider while linkAccess is restricted", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    expect(result.current.indexProvider).toBeNull()
    expect(providerInstances).toHaveLength(0)
  })

  it("connects a provider once linkAccess moves away from restricted, using the notebook's index room", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    act(() => {
      result.current.setLinkAccess?.("view")
    })

    expect(providerInstances).toHaveLength(1)
    expect(providerInstances[0].roomName).toBe(`nb:${id}:index`)
    expect(result.current.indexProvider).toBe(providerInstances[0])
  })

  it("disconnects the provider when linkAccess moves back to restricted", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    act(() => result.current.setLinkAccess?.("view"))
    const provider = providerInstances[0]

    act(() => result.current.setLinkAccess?.("restricted"))

    expect(provider.disconnect).toHaveBeenCalledTimes(1)
    expect(provider.destroy).toHaveBeenCalledTimes(1)
    expect(result.current.indexProvider).toBeNull()
  })

  it("disconnects the provider on unmount", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", []))
    const updateNotebookRoot = vi.fn()
    const { result, unmount } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    await waitFor(() => expect(result.current.treeReady).toBe(true))

    act(() => result.current.setLinkAccess?.("view"))
    const provider = providerInstances[0]

    unmount()

    expect(provider.disconnect).toHaveBeenCalledTimes(1)
    expect(provider.destroy).toHaveBeenCalledTimes(1)
  })
})

describe("useNotebookFileSystem: persisting local edits", () => {
  it("persists local tree mutations to both the caller and the index doc", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a"), note("b")]))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    const indexHandle = createNotebookIndexDoc(id)

    await waitFor(() => expect(readNotebookIndexTree(indexHandle).root).toEqual(nb.root))

    act(() => result.current.rename("a", "renamed-a"))
    act(() => result.current.rename("b", "renamed-b"))

    await waitFor(() => {
      const persisted = readNotebookIndexTree(indexHandle).root as TreeNode
      expect(persisted.children!.map((c) => c.name)).toEqual(["renamed-a", "renamed-b"])
    })
    expect(updateNotebookRoot).toHaveBeenCalled()
  })

  // Regression test for a real bug found while writing this suite: the
  // observer used to distinguish "our own write echoing back" from a real
  // external change via a plain boolean flag (suppressPersistenceRef), which
  // only got reset when setRoot() produced a different tree reference. Since
  // the initial seed writes back the exact `notebook.root` object already
  // held by useFileSystem's controlled `root` prop, that reset never fired,
  // leaving the flag stuck true - so the very next genuine local edit was
  // silently dropped (updated the local view, but never persisted or
  // synced). Fixed by tagging the hook's own writes with a Yjs transaction
  // origin instead, so the observer can ignore its own echo directly rather
  // than relying on a flag that could be left in the wrong state.
  it("does not drop the first edit made right after the initial seed", async () => {
    const id = uniqueNotebookId()
    const nb = notebook(id, folder("root", [note("a")]))
    const updateNotebookRoot = vi.fn()
    const { result } = renderHook(() => useNotebookFileSystem(nb, updateNotebookRoot))
    const indexHandle = createNotebookIndexDoc(id)

    await waitFor(() => expect(readNotebookIndexTree(indexHandle).root).toEqual(nb.root))
    updateNotebookRoot.mockClear()

    act(() => result.current.rename("a", "renamed"))

    await waitFor(() => {
      expect((readNotebookIndexTree(indexHandle).root as TreeNode).children![0].name).toBe("renamed")
    })
    expect(updateNotebookRoot).toHaveBeenCalledWith(id, expect.objectContaining({
      children: [expect.objectContaining({ id: "a", name: "renamed" })],
    }))
  })
})
