import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { buildNoteEdges, collectNoteLinks } from "./note-graph"

describe("note graph", () => {
  it("reads nested note links, deduplicates targets, and reflects removal", () => {
    const doc = new Y.Doc()
    const paragraph = new Y.XmlElement("paragraph")
    const link = () => {
      const node = new Y.XmlElement("noteLink")
      node.setAttribute("noteId", "target")
      return node
    }
    paragraph.insert(0, [link(), link(), new Y.XmlElement("noteLink"), new Y.XmlElement("image")])
    doc.getXmlFragment("default").insert(0, [paragraph])
    expect(collectNoteLinks(doc)).toEqual(["target"])
    paragraph.delete(0, 2)
    expect(collectNoteLinks(doc)).toEqual([])
    doc.destroy()
  })

  it("merges reciprocal links and excludes deleted notes and self links", () => {
    expect(buildNoteEdges(["a", "b", "isolated"], {
      a: ["a", "b", "deleted"], b: ["a"], deleted: ["isolated"],
    })).toEqual([{ source: "a", target: "b" }])
  })
})
