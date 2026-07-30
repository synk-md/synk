import { describe, expect, it, vi, beforeEach } from "vitest"
import * as Y from "yjs"
import {
  extensionOf,
  isImportableNoteFile,
  plainTextToDoc,
  importNoteContent,
} from "./note-import"

// Mirrors the mocking approach in use-background-note-sync.test.ts: swap the
// real IndexedDB-backed Y.Doc for an in-memory one, keyed the same way
// getOrCreateYDoc keys its cache, so import/export tests round-trip through
// the same doc without needing a real IndexedDB in jsdom.
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

describe("extensionOf", () => {
  it("lowercases the extension", () => {
    expect(extensionOf("notes.MD")).toBe("md")
  })

  it("returns the last extension for multi-dot filenames", () => {
    expect(extensionOf("my.notes.backup.txt")).toBe("txt")
  })

  it("returns an empty string when there's no extension", () => {
    expect(extensionOf("README")).toBe("")
  })
})

describe("isImportableNoteFile", () => {
  it.each([
    ["notes.md", "text/plain"],
    ["notes.markdown", "text/plain"],
    ["notes.txt", "text/plain"],
    ["notes.json", "application/json"],
  ])("accepts %s by extension", (name, type) => {
    expect(isImportableNoteFile(new File(["content"], name, { type }))).toBe(true)
  })

  it("accepts a recognized mime type even with an unrecognized extension", () => {
    const file = new File(["content"], "notes.bin", { type: "text/markdown" })
    expect(isImportableNoteFile(file)).toBe(true)
  })

  it("rejects unrelated file types", () => {
    const file = new File(["binary"], "photo.png", { type: "image/png" })
    expect(isImportableNoteFile(file)).toBe(false)
  })
})

describe("plainTextToDoc", () => {
  it("wraps a single line of text in one paragraph", () => {
    expect(plainTextToDoc("hello")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    })
  })

  it("produces one paragraph per line, with empty content for blank lines", () => {
    const doc = plainTextToDoc("line one\n\nline three")
    expect(doc.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "line one" }] },
      { type: "paragraph", content: [] },
      { type: "paragraph", content: [{ type: "text", text: "line three" }] },
    ])
  })

  it("produces a single empty paragraph for empty input", () => {
    expect(plainTextToDoc("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    })
  })
})

describe("importNoteContent", () => {
  it("imports plain text content into the note's Y.Doc", async () => {
    await importNoteContent("nb1", "note-a", "notes.txt", "hello world")

    const doc = docsByKey.get("nb1:note-a")!
    expect(doc.getXmlFragment("default").toString()).toContain("hello world")
  })

  it("imports JSON content matching the tiptap document schema", async () => {
    const json = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "from json" }] }],
    }
    await importNoteContent("nb1", "note-b", "notes.json", JSON.stringify(json))

    const doc = docsByKey.get("nb1:note-b")!
    expect(doc.getXmlFragment("default").toString()).toContain("from json")
  })

  it("imports markdown content, converting formatting", async () => {
    await importNoteContent("nb1", "note-c", "notes.md", "**bold text**")

    const doc = docsByKey.get("nb1:note-c")!
    expect(doc.getXmlFragment("default").toString()).toContain("bold text")
  })

  it("stores the provided title and createdAt in the note's meta map", async () => {
    await importNoteContent("nb1", "note-d", "notes.txt", "content", {
      title: "My Title",
      createdAt: 555,
    })

    const doc = docsByKey.get("nb1:note-d")!
    const meta = doc.getMap<any>("meta")
    expect(meta.get("title")).toBe("My Title")
    expect(meta.get("createdAt")).toBe(555)
  })

  it("defaults createdAt to now when not provided", async () => {
    const before = Date.now()
    await importNoteContent("nb1", "note-e", "notes.txt", "content")
    const after = Date.now()

    const doc = docsByKey.get("nb1:note-e")!
    const createdAt = doc.getMap<any>("meta").get("createdAt")
    expect(createdAt).toBeGreaterThanOrEqual(before)
    expect(createdAt).toBeLessThanOrEqual(after)
  })
})
