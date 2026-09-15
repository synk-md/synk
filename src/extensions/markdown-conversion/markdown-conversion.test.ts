import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { StarterKit } from "@tiptap/starter-kit"

import { Table } from "@/components/tiptap-node/table-node/table-node-extension"
import { getMarkdownContent, markdownToProseMirrorDoc } from "./markdown-conversion"

let editor: Editor | null = null

function roundTrip(markdown: string) {
  editor = new Editor({ extensions: [StarterKit, Table] })
  editor.commands.setContent(markdownToProseMirrorDoc(editor, markdown).toJSON())
  return editor
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe("markdown tables", () => {
  it("parses a GFM table into header and body cells", () => {
    const doc = roundTrip("| a | b |\n| --- | --- |\n| 1 | 2 |").state.doc
    const table = doc.firstChild!
    const cellTypes = (row: number) => table.child(row).content.content.map((c) => c.type.name)
    expect(table.type.name).toBe("table")
    expect(table.childCount).toBe(2)
    expect(cellTypes(0)).toEqual(["tableHeader", "tableHeader"])
    expect(cellTypes(1)).toEqual(["tableCell", "tableCell"])
  })

  it("round-trips inline formatting and escaped pipes", () => {
    const source = [
      "| Name | **Role** |",
      "| --- | --- |",
      "| Ada | a \\| b |",
      "| Grace | _admiral_ |",
    ].join("\n")
    expect(getMarkdownContent(roundTrip(source))).toBe(source)
  })

  it("keeps a table separated from surrounding blocks", () => {
    const source = "before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter"
    expect(getMarkdownContent(roundTrip(source))).toBe(source)
  })

  it("serializes hard breaks in a cell as <br> and pads merged cells", () => {
    const ed = roundTrip("x")
    ed.commands.setContent({
      type: "doc",
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [
            { type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [
              { type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" },
            ] }] },
            { type: "tableCell", content: [{ type: "paragraph" }] },
          ] },
        ],
      }],
    })
    expect(getMarkdownContent(ed)).toBe("| wide |  |\n| --- | --- |\n| one<br>two |  |")
  })
})
