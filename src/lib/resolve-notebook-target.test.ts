import { describe, expect, it } from "vitest"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import { createNotebookSettingsDoc, createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"
import { findFirstNoteId, resolveNotebookTargetNote } from "./resolve-notebook-target"

function note(id: string): TreeNode {
  return { id, name: id, isFolder: false }
}

function asset(id: string): TreeNode {
  return { id, name: id, isFolder: false, assetId: "sha256:1" }
}

function folder(id: string, children: TreeNode[]): TreeNode {
  return { id, name: id, isFolder: true, children }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("findFirstNoteId", () => {
  it("returns the node itself when it's already a note", () => {
    expect(findFirstNoteId(note("a"))).toBe("a")
  })

  it("returns null for an image asset leaf", () => {
    expect(findFirstNoteId(asset("img"))).toBeNull()
  })

  it("finds the first note depth-first among folders", () => {
    const tree = folder("root", [folder("empty", []), folder("sub", [note("a"), note("b")])])
    expect(findFirstNoteId(tree)).toBe("a")
  })

  it("skips asset leaves and keeps looking", () => {
    const tree = folder("root", [asset("img"), note("a")])
    expect(findFirstNoteId(tree)).toBe("a")
  })

  it("returns null for an empty tree or null/undefined input", () => {
    expect(findFirstNoteId(folder("root", []))).toBeNull()
    expect(findFirstNoteId(null)).toBeNull()
    expect(findFirstNoteId(undefined)).toBeNull()
  })
})

describe("resolveNotebookTargetNote", () => {
  it("falls back to the first note in the fallback root when nothing is persisted", async () => {
    const fallback = folder("root", [note("fallback-note")])
    const result = await resolveNotebookTargetNote("nb-fallback-only", fallback)
    expect(result).toBe("fallback-note")
  })

  it("falls back to the first note in the persisted notebook index when there's no fallback match", async () => {
    const notebookId = "nb-index-fallback"
    const indexHandle = createNotebookIndexDoc(notebookId)
    await indexHandle.idb.whenSynced
    indexHandle.tree.set("root", folder("root", [note("stored-note")]))
    await tick()

    const result = await resolveNotebookTargetNote(notebookId, null)
    expect(result).toBe("stored-note")

    evictNotebookIndexDoc(notebookId)
  })

  it("returns null when there's nothing persisted and no fallback note", async () => {
    const result = await resolveNotebookTargetNote("nb-nothing", folder("root", []))
    expect(result).toBeNull()
  })

  it("prefers an explicitly remembered lastOpenedNoteId over the index/fallback, once settings have synced", async () => {
    const notebookId = "nb-preferred"

    // Prime the settings doc and make sure the write actually reaches
    // IndexedDB before resolveNotebookTargetNote opens its own handle to it.
    const priming = createNotebookSettingsDoc(notebookId)
    await priming.idb.whenSynced
    priming.settings.set("lastOpenedNoteId", "preferred-note")
    await tick()
    priming.doc.destroy()

    const result = await resolveNotebookTargetNote(notebookId, folder("root", [note("fallback-note")]))

    expect(result).toBe("preferred-note")
  })
})
