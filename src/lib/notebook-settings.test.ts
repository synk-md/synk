import { beforeEach, describe, expect, it } from "vitest"
import {
  forgetLastOpenedNoteId,
  getLastOpenedNoteId,
  setLastOpenedNoteId,
} from "./notebook-settings"

describe("last opened note", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips synchronously, so it survives an immediate reload", () => {
    setLastOpenedNoteId("nb-1", "note-a")
    expect(getLastOpenedNoteId("nb-1")).toBe("note-a")
  })

  it("keeps notebooks independent", () => {
    setLastOpenedNoteId("nb-1", "note-a")
    setLastOpenedNoteId("nb-2", "note-b")
    expect(getLastOpenedNoteId("nb-1")).toBe("note-a")
    expect(getLastOpenedNoteId("nb-2")).toBe("note-b")
  })

  it("returns null for a notebook that has never been opened", () => {
    expect(getLastOpenedNoteId("nb-unknown")).toBeNull()
  })

  it("forgets a deleted notebook's entry without touching the others", () => {
    setLastOpenedNoteId("nb-1", "note-a")
    setLastOpenedNoteId("nb-2", "note-b")
    forgetLastOpenedNoteId("nb-1")
    expect(getLastOpenedNoteId("nb-1")).toBeNull()
    expect(getLastOpenedNoteId("nb-2")).toBe("note-b")
  })
})
