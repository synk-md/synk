import { describe, expect, it, vi, beforeEach } from "vitest"
import * as Y from "yjs"
import {
  fileExtensionForFormat,
  mimeTypeForFormat,
  exportNoteContent,
} from "./note-export"
import { importNoteContent } from "./note-import"

// Same in-memory Y.Doc stand-in as note-import.test.ts, so importing and then
// exporting the same notebookId/noteId round-trips through the same doc.
const { docsByKey } = vi.hoisted(() => ({ docsByKey: new Map<string, Y.Doc>() }))

vi.mock("@/lib/yjs-utils", () => ({
  getOrCreateYDoc: (notebookId: string, noteId: string) => {
    const key = `${notebookId}:${noteId}`
    let doc = docsByKey.get(key)
    if (!doc) {
      doc = new Y.Doc()
      docsByKey.set(key, doc)
    }
    return { doc, idb: { whenSynced: Promise.resolve() } }
  },
}))

beforeEach(() => {
  docsByKey.clear()
})

describe("fileExtensionForFormat / mimeTypeForFormat", () => {
  it.each([
    ["markdown", "md", "text/markdown"],
    ["json", "json", "application/json"],
    ["text", "txt", "text/plain"],
  ] as const)("maps %s to .%s / %s", (format, ext, mimeType) => {
    expect(fileExtensionForFormat(format)).toBe(ext)
    expect(mimeTypeForFormat(format)).toBe(mimeType)
  })
})

describe("exportNoteContent", () => {
  it("round-trips plain text content back out as markdown", async () => {
    await importNoteContent("nb1", "note-a", "notes.txt", "hello world")
    const markdown = await exportNoteContent("nb1", "note-a", "markdown")
    expect(markdown).toContain("hello world")
  })

  it("exports as JSON matching the tiptap document schema", async () => {
    await importNoteContent("nb1", "note-b", "notes.txt", "hello json")
    const json = await exportNoteContent("nb1", "note-b", "json")
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe("doc")
    expect(JSON.stringify(parsed)).toContain("hello json")
  })

  it("exports as plain text without markdown formatting", async () => {
    await importNoteContent("nb1", "note-c", "notes.md", "**bold text**")
    const text = await exportNoteContent("nb1", "note-c", "text")
    expect(text).toBe("bold text")
  })

  it("round-trips markdown formatting through markdown export", async () => {
    await importNoteContent("nb1", "note-d", "notes.md", "**bold text**")
    const markdown = await exportNoteContent("nb1", "note-d", "markdown")
    expect(markdown).toContain("**bold text**")
  })
})
