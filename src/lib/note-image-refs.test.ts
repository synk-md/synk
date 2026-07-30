import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { NoteImageRefIndex } from "./note-image-refs"

// Builds the same shape Tiptap's Collaboration extension writes: a
// Y.XmlFragment named "default" containing Y.XmlElements, where image nodes
// are named "image" and carry an assetId attribute (see image-node-extension.tsx).
function imageElement(assetId: string): Y.XmlElement {
  const el = new Y.XmlElement("image")
  el.setAttribute("assetId", assetId)
  return el
}

function paragraph(children: Y.XmlElement[] = []): Y.XmlElement {
  const el = new Y.XmlElement("paragraph")
  if (children.length) el.insert(0, children)
  return el
}

describe("NoteImageRefIndex", () => {
  it("finds a top-level image node's assetId", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    doc.transact(() => fragment.insert(0, [imageElement("sha256:a")]))

    const index = new NoteImageRefIndex(doc)
    expect(index.has("sha256:a")).toBe(true)
    expect(index.has("sha256:missing")).toBe(false)
  })

  it("finds image nodes nested inside other elements", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    doc.transact(() => fragment.insert(0, [paragraph([imageElement("sha256:nested")])]))

    const index = new NoteImageRefIndex(doc)
    expect(index.has("sha256:nested")).toBe(true)
  })

  it("dedups repeated assetIds and tracks each distinct one", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    doc.transact(() =>
      fragment.insert(0, [imageElement("sha256:dup"), imageElement("sha256:dup"), imageElement("sha256:other")]),
    )

    const index = new NoteImageRefIndex(doc)
    expect(index.has("sha256:dup")).toBe(true)
    expect(index.has("sha256:other")).toBe(true)
  })

  it("uses a non-default collaboration field when given one", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("custom-field")
    doc.transact(() => fragment.insert(0, [imageElement("sha256:custom")]))

    const index = new NoteImageRefIndex(doc, "custom-field")
    expect(index.has("sha256:custom")).toBe(true)
  })

  it("invalidates its cache and reflects assets added after the first has() call", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    const index = new NoteImageRefIndex(doc)

    expect(index.has("sha256:later")).toBe(false)
    doc.transact(() => fragment.insert(0, [imageElement("sha256:later")]))
    expect(index.has("sha256:later")).toBe(true)
  })

  it("reflects removals too", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    doc.transact(() => fragment.insert(0, [imageElement("sha256:removable")]))
    const index = new NoteImageRefIndex(doc)
    expect(index.has("sha256:removable")).toBe(true)

    doc.transact(() => fragment.delete(0, 1))
    expect(index.has("sha256:removable")).toBe(false)
  })

  it("stops tracking further document changes once destroyed", () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    const index = new NoteImageRefIndex(doc)

    index.destroy()
    // destroy() itself clears the cache, so this first post-destroy call
    // still does one fresh (accurate) walk and repopulates the cache.
    expect(index.has("sha256:after-destroy")).toBe(false)

    // With the observer detached, this mutation no longer invalidates that
    // cache, so a later has() call keeps returning the now-stale answer.
    doc.transact(() => fragment.insert(0, [imageElement("sha256:after-destroy")]))
    expect(index.has("sha256:after-destroy")).toBe(false)
  })
})
