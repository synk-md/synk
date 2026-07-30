import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import {
  readNoteMeta,
  setNoteCreatedAt,
  setNoteTitle,
  setNoteTags,
  markArchived,
  setSeeded,
  getNoteLinkAccess,
  setNoteLinkAccess,
  isNoteLinkAccessInherited,
  setNoteLinkAccessInherited,
  getNoteOwnerName,
  setNoteOwnerName,
} from "./note-meta"

function metaMap(): Y.Map<any> {
  return new Y.Doc().getMap("meta")
}

describe("readNoteMeta", () => {
  it("returns sensible defaults for a brand-new meta map", () => {
    const meta = readNoteMeta(metaMap())
    expect(meta.title).toBe("")
    expect(meta.tags).toEqual([])
    expect(meta.archived).toBe(false)
    expect(meta.seeded).toBe(false)
    expect(meta.createdAt).toBeTypeOf("number")
  })

  it("reflects values that were actually set", () => {
    const meta = metaMap()
    setNoteTitle(meta, "My Note")
    setNoteTags(meta, ["a", "b"])
    markArchived(meta, true)
    setSeeded(meta, true)
    setNoteCreatedAt(meta)

    const read = readNoteMeta(meta)
    expect(read.title).toBe("My Note")
    expect(read.tags).toEqual(["a", "b"])
    expect(read.archived).toBe(true)
    expect(read.seeded).toBe(true)
    expect(read.createdAt).toBeTypeOf("number")
  })
})

describe("link access", () => {
  it("defaults to restricted", () => {
    expect(getNoteLinkAccess(metaMap())).toBe("restricted")
  })

  it("round-trips a set value", () => {
    const meta = metaMap()
    setNoteLinkAccess(meta, "edit")
    expect(getNoteLinkAccess(meta)).toBe("edit")
  })
})

describe("link access inheritance", () => {
  it("is inherited by default for an untouched note", () => {
    expect(isNoteLinkAccessInherited(metaMap())).toBe(true)
  })

  it("is not inherited once linkAccess was set without an explicit inherited flag (pre-tracking notes)", () => {
    const meta = metaMap()
    setNoteLinkAccess(meta, "view")
    expect(isNoteLinkAccessInherited(meta)).toBe(false)
  })

  it("honors an explicit inherited flag regardless of linkAccess", () => {
    const meta = metaMap()
    setNoteLinkAccess(meta, "view")
    setNoteLinkAccessInherited(meta, true)
    expect(isNoteLinkAccessInherited(meta)).toBe(true)

    setNoteLinkAccessInherited(meta, false)
    expect(isNoteLinkAccessInherited(meta)).toBe(false)
  })
})

describe("owner name", () => {
  it("is undefined until set", () => {
    expect(getNoteOwnerName(metaMap())).toBeUndefined()
  })

  it("round-trips a set value", () => {
    const meta = metaMap()
    setNoteOwnerName(meta, "Alice")
    expect(getNoteOwnerName(meta)).toBe("Alice")
  })
})
