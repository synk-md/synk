import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import {
  keyForIndex,
  newNotebookId,
  newNoteId,
  SIGNALING_SERVERS,
  getOrCreateYDoc,
  createNotebookIndexDoc,
  evictNotebookIndexDoc,
  deleteNoteFromIndexedDB,
  deleteNotebookMetaFromIndexedDB,
  readNotebookIndexTree,
  writeNotebookIndexTree,
  flushPersistedDocs,
} from "./yjs-utils"

function note(id: string): TreeNode {
  return { id, name: id, isFolder: false }
}

function folder(id: string, children: TreeNode[]): TreeNode {
  return { id, name: id, isFolder: true, children }
}

describe("keyForIndex", () => {
  it("namespaces the notebook id for its index/WebRTC room name", () => {
    expect(keyForIndex("nb1")).toBe("nb:nb1:index")
  })
})

describe("newNotebookId / newNoteId", () => {
  it("generates 10-character alphanumeric ids", () => {
    expect(newNotebookId()).toMatch(/^[0-9A-Za-z]{10}$/)
    expect(newNoteId()).toMatch(/^[0-9A-Za-z]{10}$/)
  })

  it("generates distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newNoteId()))
    expect(ids.size).toBe(50)
  })
})

describe("SIGNALING_SERVERS", () => {
  it("includes the public fallback signaling servers", () => {
    expect(SIGNALING_SERVERS.every((url) => url.startsWith("ws"))).toBe(true)
  })
})

describe("getOrCreateYDoc", () => {
  it("returns the same cached doc/idb for the same notebookId+noteId", () => {
    const first = getOrCreateYDoc("nb-cache", "note-cache")
    const second = getOrCreateYDoc("nb-cache", "note-cache")
    expect(second.doc).toBe(first.doc)
    expect(second.idb).toBe(first.idb)
  })

  it("returns a distinct doc for a different notebookId or noteId", () => {
    const a = getOrCreateYDoc("nb-x", "note-x")
    const b = getOrCreateYDoc("nb-x", "note-y")
    const c = getOrCreateYDoc("nb-y", "note-x")
    expect(a.doc).not.toBe(b.doc)
    expect(a.doc).not.toBe(c.doc)
  })
})

describe("createNotebookIndexDoc / evictNotebookIndexDoc", () => {
  it("caches the index doc per notebookId", () => {
    const first = createNotebookIndexDoc("nb-index-1")
    const second = createNotebookIndexDoc("nb-index-1")
    expect(second.doc).toBe(first.doc)
    expect(second.nodes).toBe(first.nodes)
    expect(second.meta).toBe(first.meta)
  })

  it("shares node/meta writes between callers holding the same cached doc", () => {
    const first = createNotebookIndexDoc("nb-index-2")
    first.nodes.set("root", { parentId: null, name: "root", isFolder: true })
    const second = createNotebookIndexDoc("nb-index-2")
    expect(second.nodes.get("root")).toEqual({ parentId: null, name: "root", isFolder: true })
  })

  it("evicts the cached doc so a later call creates a fresh one", () => {
    const first = createNotebookIndexDoc("nb-index-3")
    evictNotebookIndexDoc("nb-index-3")
    const second = createNotebookIndexDoc("nb-index-3")
    expect(second.doc).not.toBe(first.doc)
  })

  it("is a safe no-op when nothing is cached for that notebookId", () => {
    expect(() => evictNotebookIndexDoc("nb-index-never-created")).not.toThrow()
  })
})

describe("readNotebookIndexTree / writeNotebookIndexTree", () => {
  it("round-trips a tree through per-node storage", () => {
    const indexHandle = createNotebookIndexDoc("nb-rw-1")
    const root = folder("root", [note("a"), note("b")])

    const { flat } = writeNotebookIndexTree(indexHandle, new Map(), root, null)

    expect(readNotebookIndexTree(indexHandle).root).toEqual(root)
    expect(flat.size).toBe(3) // root + a + b
  })

  it("only touches the Yjs entries for nodes that actually changed", () => {
    const indexHandle = createNotebookIndexDoc("nb-rw-2")
    const before = writeNotebookIndexTree(
      indexHandle,
      new Map(),
      folder("root", [note("a"), note("b")]),
      null,
    )

    const setSpy = vi.spyOn(indexHandle.nodes, "set")
    writeNotebookIndexTree(
      indexHandle,
      before.flat,
      folder("root", [{ ...note("a"), name: "renamed-a" }, note("b")]),
      null,
    )

    // Only "a" changed - "root" and "b" must not be rewritten.
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith("a", expect.objectContaining({ name: "renamed-a" }))
    setSpy.mockRestore()
  })

  it("deletes nodes that were removed from the tree", () => {
    const indexHandle = createNotebookIndexDoc("nb-rw-3")
    const before = writeNotebookIndexTree(
      indexHandle,
      new Map(),
      folder("root", [note("a"), note("b")]),
      null,
    )

    writeNotebookIndexTree(indexHandle, before.flat, folder("root", [note("a")]), null)

    expect(indexHandle.nodes.has("b")).toBe(false)
    expect(readNotebookIndexTree(indexHandle).root).toEqual(folder("root", [note("a")]))
  })

  // The core regression this per-node storage exists to fix: the old format
  // stored the whole tree as one Yjs map value, so a concurrent write from
  // another peer/session didn't merge - it replaced the entire tree,
  // silently dropping whichever notes only existed on the losing side (see
  // use-notebook-filesystem.ts's history). With one map entry per node,
  // two independent writers adding different nodes both survive.
  it("merges concurrent writes to different nodes instead of one clobbering the other", () => {
    const indexHandle = createNotebookIndexDoc("nb-rw-4")
    const base = writeNotebookIndexTree(indexHandle, new Map(), folder("root", [note("a")]), null)

    // Two independent writers, each starting from the same base snapshot -
    // simulates a host offline-editing locally while a peer edits too.
    writeNotebookIndexTree(indexHandle, base.flat, folder("root", [note("a"), note("from-host")]), null)
    writeNotebookIndexTree(indexHandle, base.flat, folder("root", [note("a"), note("from-peer")]), null)

    const { root } = readNotebookIndexTree(indexHandle)
    expect(root?.children?.map((c) => c.id).sort()).toEqual(["a", "from-host", "from-peer"])
  })
})

describe("deleteNoteFromIndexedDB / deleteNotebookMetaFromIndexedDB", () => {
  it("removes a note's persisted Y.Doc updates from IndexedDB", async () => {
    const notebookId = "nb-delete-1"
    const noteId = "note-delete-1"
    const doc = new Y.Doc()
    const idb = new IndexeddbPersistence(`nb:${notebookId}:n:${noteId}`, doc)
    await idb.whenSynced
    doc.getMap("meta").set("title", "to be deleted")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await idb.destroy()

    await deleteNoteFromIndexedDB(notebookId, noteId)

    const reloadedDoc = new Y.Doc()
    const reloadedIdb = new IndexeddbPersistence(`nb:${notebookId}:n:${noteId}`, reloadedDoc)
    await reloadedIdb.whenSynced
    expect(reloadedDoc.getMap("meta").get("title")).toBeUndefined()
    await reloadedIdb.destroy()
  })

  it("removes a notebook's index doc from IndexedDB", async () => {
    const notebookId = "nb-delete-2"
    const indexDoc = new Y.Doc()
    const indexIdb = new IndexeddbPersistence(`nb:${notebookId}:index`, indexDoc)
    await indexIdb.whenSynced
    indexDoc.getMap("tree").set("root", { id: "root" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await indexIdb.destroy()

    await deleteNotebookMetaFromIndexedDB(notebookId)

    const reloadedIndex = new Y.Doc()
    const reloadedIndexIdb = new IndexeddbPersistence(`nb:${notebookId}:index`, reloadedIndex)
    await reloadedIndexIdb.whenSynced
    expect(reloadedIndex.getMap("tree").get("root")).toBeUndefined()
    await reloadedIndexIdb.destroy()
  })

  it("resolves without throwing for a notebook/note that was never persisted", async () => {
    await expect(deleteNoteFromIndexedDB("nb-never", "note-never")).resolves.toBeUndefined()
    await expect(deleteNotebookMetaFromIndexedDB("nb-never-meta")).resolves.toBeUndefined()
  })
})

describe("flushPersistedDocs", () => {
  it("waits for queued writes to commit, with no arbitrary timeout", async () => {
    const notebookId = "nb-flush-1"
    const noteId = "note-flush-1"
    const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
    await idb.whenSynced

    doc.getMap("meta").set("title", "written just before a reload")

    // The point of the barrier: the write is readable back straight after,
    // without the `setTimeout(0)` the other tests here have to use.
    await flushPersistedDocs()

    const reloadedDoc = new Y.Doc()
    const reloadedIdb = new IndexeddbPersistence(`nb:${notebookId}:n:${noteId}`, reloadedDoc)
    await reloadedIdb.whenSynced
    expect(reloadedDoc.getMap("meta").get("title")).toBe("written just before a reload")
    await reloadedIdb.destroy()
  })

  it("resolves when nothing has been persisted yet", async () => {
    await expect(flushPersistedDocs()).resolves.toBeUndefined()
  })
})
