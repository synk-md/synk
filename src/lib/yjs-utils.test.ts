import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import {
  keyForIndex,
  newNotebookId,
  newNoteId,
  SIGNALING_SERVERS,
  getOrCreateYDoc,
  createNotebookSettingsDoc,
  createNotebookIndexDoc,
  evictNotebookIndexDoc,
  deleteNoteFromIndexedDB,
  deleteNotebookMetaFromIndexedDB,
} from "./yjs-utils"

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
    expect(SIGNALING_SERVERS).toContain("wss://signaling.yjs.dev")
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

describe("createNotebookSettingsDoc", () => {
  it("returns a working settings Y.Map bound to its own Y.Doc", async () => {
    const { doc, idb, settings } = createNotebookSettingsDoc("nb-settings-1")
    await idb.whenSynced
    settings.set("theme", "dark")
    expect(doc.getMap("settings").get("theme")).toBe("dark")
  })

  it("is not cached: each call creates a fresh doc", () => {
    const a = createNotebookSettingsDoc("nb-settings-2")
    const b = createNotebookSettingsDoc("nb-settings-2")
    expect(a.doc).not.toBe(b.doc)
  })
})

describe("createNotebookIndexDoc / evictNotebookIndexDoc", () => {
  it("caches the index doc per notebookId", () => {
    const first = createNotebookIndexDoc("nb-index-1")
    const second = createNotebookIndexDoc("nb-index-1")
    expect(second.doc).toBe(first.doc)
    expect(second.tree).toBe(first.tree)
    expect(second.meta).toBe(first.meta)
  })

  it("shares tree/meta writes between callers holding the same cached doc", () => {
    const first = createNotebookIndexDoc("nb-index-2")
    first.tree.set("root", { id: "root" })
    const second = createNotebookIndexDoc("nb-index-2")
    expect(second.tree.get("root")).toEqual({ id: "root" })
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

  it("removes a notebook's settings and index docs from IndexedDB", async () => {
    const notebookId = "nb-delete-2"
    const settingsDoc = new Y.Doc()
    const settingsIdb = new IndexeddbPersistence(`nb:${notebookId}:settings`, settingsDoc)
    await settingsIdb.whenSynced
    settingsDoc.getMap("settings").set("theme", "dark")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settingsIdb.destroy()

    const indexDoc = new Y.Doc()
    const indexIdb = new IndexeddbPersistence(`nb:${notebookId}:index`, indexDoc)
    await indexIdb.whenSynced
    indexDoc.getMap("tree").set("root", { id: "root" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await indexIdb.destroy()

    await deleteNotebookMetaFromIndexedDB(notebookId)

    const reloadedSettings = new Y.Doc()
    const reloadedSettingsIdb = new IndexeddbPersistence(`nb:${notebookId}:settings`, reloadedSettings)
    await reloadedSettingsIdb.whenSynced
    expect(reloadedSettings.getMap("settings").get("theme")).toBeUndefined()
    await reloadedSettingsIdb.destroy()

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
