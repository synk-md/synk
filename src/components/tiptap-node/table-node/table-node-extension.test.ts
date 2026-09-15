import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { StarterKit } from "@tiptap/starter-kit"

import { Table, allocateColumnWidths } from "./table-node-extension"

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

const round = (widths: number[]) => widths.map((w) => Math.round(w))

describe("allocateColumnWidths", () => {
  it("keeps columns equal while all content fits in an equal share", () => {
    expect(round(allocateColumnWidths([0, 0, 0], 600))).toEqual([200, 200, 200])
    expect(round(allocateColumnWidths([150, 40, 190], 600))).toEqual([200, 200, 200])
  })

  it("gives a column only the extra room it needs, splitting the rest equally", () => {
    expect(round(allocateColumnWidths([50, 50, 250], 600))).toEqual([175, 175, 250])
  })

  it("keeps fitting columns at their natural width when content overflows", () => {
    expect(round(allocateColumnWidths([100, 900, 1200], 600))).toEqual([100, 250, 250])
  })

  it("doesn't squeeze empty columns below the minimum", () => {
    expect(round(allocateColumnWidths([0, 2000], 600))).toEqual([64, 536])
  })
})

describe("table node view", () => {
  it("renders equal columns before anything is measured", () => {
    const element = document.createElement("div")
    editor = new Editor({ element, extensions: [StarterKit, Table] })
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    const widths = Array.from(element.querySelectorAll(".tableWrapper > table > colgroup > col"))
      .map((col) => (col as HTMLElement).style.width)
    expect(widths).toEqual(["33.333%", "33.333%", "33.333%"])
  })
})
