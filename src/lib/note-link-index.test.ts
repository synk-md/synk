import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import { NoteLinkTracker, getNoteLinkIndex } from "./note-link-index"
import { ensureNoteLinks, getOrCreateYDoc } from "./yjs-utils"

function link(id: string) {
  const node = new Y.XmlElement("noteLink")
  node.setAttribute("noteId", id)
  return node
}

describe("incremental note links", () => {
  it("tracks duplicate targets, retargeting, nested deletion and undo", () => {
    const doc = new Y.Doc()
    const root = doc.getXmlFragment("default")
    const parent = new Y.XmlElement("paragraph")
    parent.insert(0, [link("a"), link("a")])
    root.insert(0, [parent])
    const publish = vi.fn()
    const tracker = new NoteLinkTracker(doc, publish)
    const undo = new Y.UndoManager(root)
    expect(publish).toHaveBeenLastCalledWith(["a"])
    parent.delete(0, 1)
    expect(publish).toHaveBeenCalledTimes(1)
    ;(parent.get(0) as Y.XmlElement).setAttribute("noteId", "b")
    expect(publish).toHaveBeenLastCalledWith(["b"])
    undo.stopCapturing()
    root.delete(0, 1)
    expect(publish).toHaveBeenLastCalledWith([])
    undo.undo()
    expect(publish).toHaveBeenLastCalledWith(["b"])
    tracker.destroy(); doc.destroy()
  })

  it("does not traverse XML or publish when text or marks change", () => {
    const doc = new Y.Doc()
    const root = doc.getXmlFragment("default")
    const parent = new Y.XmlElement("paragraph")
    const text = new Y.XmlText("hello")
    parent.insert(0, [text, link("a")]); root.insert(0, [parent])
    const publish = vi.fn()
    const tracker = new NoteLinkTracker(doc, publish)
    const rootScan = vi.spyOn(root, "toArray"), paragraphScan = vi.spyOn(parent, "toArray")
    text.insert(5, " world")
    text.format(0, 5, { bold: true })
    parent.setAttribute("align", "center")
    expect(rootScan).not.toHaveBeenCalled()
    expect(paragraphScan).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(1)
    tracker.destroy(); doc.destroy()
  })

  it("handles remote subtree replacement", () => {
    const doc = new Y.Doc(), remote = new Y.Doc()
    const publish = vi.fn()
    const tracker = new NoteLinkTracker(doc, publish)
    const root = remote.getXmlFragment("default")
    root.insert(0, [link("remote")])
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote))
    expect(publish).toHaveBeenLastCalledWith(["remote"])
    root.delete(0, 1)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote))
    expect(publish).toHaveBeenLastCalledWith([])
    tracker.destroy(); doc.destroy(); remote.destroy()
  })

  it("backfills persisted notes once and uses the index on subsequent reads", async () => {
    const notebook = "legacy-links"
    const doc = new Y.Doc()
    const idb = new IndexeddbPersistence(`nb:${notebook}:n:source`, doc)
    await idb.whenSynced
    doc.getXmlFragment("default").insert(0, [link("target")])
    // Wait for the provider's queued writes before closing the source.
    await idb.destroy(); doc.destroy()
    const destroy = vi.spyOn(Y.Doc.prototype, "destroy")
    await ensureNoteLinks(notebook, ["source"])
    expect(destroy).toHaveBeenCalledOnce()
    destroy.mockRestore()
    const index = getNoteLinkIndex(notebook)
    expect(index.links.get("source")).toEqual(["target"])
    const persisted = new Y.Doc()
    const persistedIdb = new IndexeddbPersistence(`nb:${notebook}:links-v1`, persisted)
    await persistedIdb.whenSynced
    expect(persisted.getMap("links").get("source")).toEqual(["target"])
    await persistedIdb.destroy(); persisted.destroy()
    const scan = vi.spyOn(Y.Doc.prototype, "getXmlFragment")
    await ensureNoteLinks(notebook, ["source"])
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
  })

  it("cancels a backfill and can resume later", async () => {
    const controller = new AbortController()
    controller.abort()
    await ensureNoteLinks("cancel-links", ["a", "b"], controller.signal)
    const index = getNoteLinkIndex("cancel-links")
    expect(index.links.size).toBe(0)
    const changed = vi.fn()
    index.links.observe(changed)
    await ensureNoteLinks("cancel-links", ["a", "b"])
    expect(changed).toHaveBeenCalledOnce()
    index.links.unobserve(changed)
    expect(index.links.get("a")).toEqual([])
    expect(index.links.get("b")).toEqual([])
  })

  it("indexes documents opened without a graph and updates after sync", async () => {
    const { doc, idb } = getOrCreateYDoc("live-links", "source")
    const index = getNoteLinkIndex("live-links")
    await Promise.all([idb.whenSynced, index.idb.whenSynced])
    doc.getXmlFragment("default").insert(0, [link("target")])
    await vi.waitFor(() => expect(index.links.get("source")).toEqual(["target"]))
    doc.getXmlFragment("default").delete(0, 1)
    expect(index.links.get("source")).toEqual([])
  })
})
