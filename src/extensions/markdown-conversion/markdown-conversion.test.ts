import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { StarterKit } from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"

import { Table } from "@/components/tiptap-node/table-node/table-node-extension"
import { getMarkdownContent, handleTaskListPaste, markdownToProseMirrorDoc } from "./markdown-conversion"

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

function fakePaste(text: string, html = "") {
  const data: Record<string, string> = { "text/plain": text, "text/html": html }
  return { clipboardData: { getData: (type: string) => data[type] ?? "" } } as unknown as ClipboardEvent
}

describe("task list paste", () => {
  it("converts plain-text markdown checklist lines into a real task list", () => {
    editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem] })
    const handled = handleTaskListPaste(editor, fakePaste("- [ ] Buy milk\n- [x] Done"))
    expect(handled).toBe(true)

    const doc = editor.state.doc
    expect(doc.firstChild!.type.name).toBe("taskList")
    const items = doc.firstChild!
    expect(items.childCount).toBe(2)
    expect(items.child(0).attrs.checked).toBe(false)
    expect(items.child(1).attrs.checked).toBe(true)
  })

  it("leaves plain text without checklist syntax alone", () => {
    editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem] })
    const handled = handleTaskListPaste(editor, fakePaste("just a note"))
    expect(handled).toBe(false)
  })

  it("defers to default HTML paste handling when the clipboard already has our own task list markup", () => {
    editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem] })
    const html = '<ul data-type="taskList"><li data-type="taskItem"><input type="checkbox">Buy milk</li></ul>'
    const handled = handleTaskListPaste(editor, fakePaste("- [ ] Buy milk", html))
    expect(handled).toBe(false)
  })

  it("converts generic <li><input type=checkbox> HTML (e.g. copied from a rendered web checklist) into a task list", () => {
    editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem] })
    const html =
      '<ul>' +
      '<li><input disabled="" type="checkbox"> Buy milk</li>' +
      '<li><input disabled="" type="checkbox" checked=""> Done</li>' +
      '</ul>'
    const handled = handleTaskListPaste(editor, fakePaste("Buy milk\nDone", html))
    expect(handled).toBe(true)

    const doc = editor.state.doc
    expect(doc.firstChild!.type.name).toBe("taskList")
    const items = doc.firstChild!
    expect(items.childCount).toBe(2)
    expect(items.child(0).attrs.checked).toBe(false)
    expect(items.child(0).textContent).toBe("Buy milk")
    expect(items.child(1).attrs.checked).toBe(true)
    expect(items.child(1).textContent).toBe("Done")
  })
})
