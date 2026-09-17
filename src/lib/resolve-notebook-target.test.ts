import { describe, expect, it } from "vitest"
import { flattenTree, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"
import { forgetLastOpenedNoteId, setLastOpenedNoteId } from "@/lib/notebook-settings"
import { findFirstNoteId, pickNotebookTargetNote, resolveNotebookTargetNote } from "./resolve-notebook-target"

function note(id: string): TreeNode {
  return { id, name: id, isFolder: false }
}

function asset(id: string): TreeNode {
  return { id, name: id, isFolder: false, assetId: "sha256:1" }
}

function folder(id: string, children: TreeNode[]): TreeNode {
  return { id, name: id, isFolder: true, children }
}

// The index doc's Yjs storage is one node per Yjs map entry (see
// yjs-utils.ts), not a single tree blob - seed it through this helper
// rather than writing a whole tree into one key directly.
function seedIndexNodes(indexHandle: ReturnType<typeof createNotebookIndexDoc>, root: TreeNode) {
  const flat = flattenTree(root)
  indexHandle.doc.transact(() => {
    for (const [id, record] of flat) indexHandle.nodes.set(id, record)
  })
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
    seedIndexNodes(indexHandle, folder("root", [note("stored-note")]))
    await tick()

    const result = await resolveNotebookTargetNote(notebookId, null)
    expect(result).toBe("stored-note")

    evictNotebookIndexDoc(notebookId)
  })

  it("returns null when there's nothing persisted and no fallback note", async () => {
    const result = await resolveNotebookTargetNote("nb-nothing", folder("root", []))
    expect(result).toBeNull()
  })

  it("prefers an explicitly remembered last opened note over the index/fallback", async () => {
    const notebookId = "nb-preferred"
    setLastOpenedNoteId(notebookId, "preferred-note")

    const result = await resolveNotebookTargetNote(notebookId, folder("root", [note("fallback-note")]))

    expect(result).toBe("preferred-note")
  })
})

describe("pickNotebookTargetNote", () => {
  const tree = folder("root", [note("first-note"), note("second-note")])

  it("prefers the note this device was last on over the first note in the tree", () => {
    forgetLastOpenedNoteId("nb-pick")
    setLastOpenedNoteId("nb-pick", "second-note")
    expect(pickNotebookTargetNote("nb-pick", tree)).toBe("second-note")
  })

  it("falls back to the first note when nothing is remembered", () => {
    forgetLastOpenedNoteId("nb-pick-empty")
    expect(pickNotebookTargetNote("nb-pick-empty", tree)).toBe("first-note")
  })

  it("falls back to the first note when the remembered one has been deleted", () => {
    setLastOpenedNoteId("nb-pick-stale", "deleted-note")
    expect(pickNotebookTargetNote("nb-pick-stale", tree)).toBe("first-note")
  })

  it("returns null when the notebook has no notes at all", () => {
    setLastOpenedNoteId("nb-pick-bare", "deleted-note")
    expect(pickNotebookTargetNote("nb-pick-bare", folder("root", []))).toBeNull()
  })
})
