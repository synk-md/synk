import { describe, expect, it, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { markNoteViewed, useUnreadNoteIds } from "./use-unread-notes"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"

function note(id: string, modifiedAt?: number): TreeNode {
  return { id, name: id, isFolder: false, modifiedAt }
}

function folder(id: string, children: TreeNode[]): TreeNode {
  return { id, name: id, isFolder: true, children }
}

beforeEach(() => {
  localStorage.clear()
})

describe("useUnreadNoteIds", () => {
  it("flags a note modified after it was last viewed", () => {
    markNoteViewed("a", 100)
    const tree = folder("root", [note("a", 200)])

    const { result } = renderHook(() => useUnreadNoteIds(tree, null))

    expect(result.current.has("a")).toBe(true)
  })

  it("does not flag a note modified before it was last viewed", () => {
    markNoteViewed("a", 200)
    const tree = folder("root", [note("a", 100)])

    const { result } = renderHook(() => useUnreadNoteIds(tree, null))

    expect(result.current.has("a")).toBe(false)
  })

  it("never flags a note that has no recorded lastViewedAt", () => {
    const tree = folder("root", [note("a", 200)])

    const { result } = renderHook(() => useUnreadNoteIds(tree, null))

    expect(result.current.size).toBe(0)
  })

  it("excludes the currently active note even if it was edited since last viewed", () => {
    markNoteViewed("a", 100)
    const tree = folder("root", [note("a", 200)])

    const { result } = renderHook(() => useUnreadNoteIds(tree, "a"))

    expect(result.current.has("a")).toBe(false)
  })

  it("ignores notes with no modifiedAt", () => {
    markNoteViewed("a", 100)
    const tree = folder("root", [note("a", undefined)])

    const { result } = renderHook(() => useUnreadNoteIds(tree, null))

    expect(result.current.size).toBe(0)
  })

  it("skips folders and only collects leaf notes, including nested ones", () => {
    markNoteViewed("a", 100)
    markNoteViewed("b", 100)
    const tree = folder("root", [
      note("a", 200),
      folder("sub", [note("b", 200)]),
    ])

    const { result } = renderHook(() => useUnreadNoteIds(tree, null))

    expect(result.current).toEqual(new Set(["a", "b"]))
  })

  it("returns an empty set for a null/undefined tree", () => {
    const { result } = renderHook(() => useUnreadNoteIds(null, null))
    expect(result.current.size).toBe(0)
  })
})

describe("markNoteViewed", () => {
  it("is a no-op for a null/undefined noteId", () => {
    expect(() => markNoteViewed(null)).not.toThrow()
    expect(() => markNoteViewed(undefined)).not.toThrow()
    expect(localStorage.length).toBe(0)
  })
})
