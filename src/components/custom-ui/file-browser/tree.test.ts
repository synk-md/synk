import { describe, expect, it } from "vitest"
import {
  clone,
  isNoteNode,
  findNode,
  updateAtPath,
  insertNode,
  collectLeaves,
  collectSharedNotes,
  collectNoteEntries,
  collectFolderEntries,
  deleteNode,
  moveNode,
  renameNode,
  setExpanded,
  collapseAll,
  setNodeLinkAccess,
  touchNodeModifiedAt,
  findAssetNode,
  ensureAssetNode,
  upsertChildren,
  flattenTree,
  buildTreeFromFlat,
  diffFlatTrees,
  type TreeNode,
} from "./tree"

function note(id: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, isFolder: false, ...overrides }
}

function asset(id: string, assetId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, isFolder: false, assetId, ...overrides }
}

function folder(id: string, children: TreeNode[], overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, isFolder: true, children, ...overrides }
}

describe("clone", () => {
  it("returns a deep copy that doesn't share references", () => {
    const tree = folder("root", [note("a")])
    const copy = clone(tree)
    expect(copy).toEqual(tree)
    expect(copy).not.toBe(tree)
    expect(copy.children).not.toBe(tree.children)
  })
})

describe("isNoteNode", () => {
  it("is true for a plain leaf", () => {
    expect(isNoteNode(note("a"))).toBe(true)
  })

  it("is false for a folder", () => {
    expect(isNoteNode(folder("f", []))).toBe(false)
  })

  it("is false for an image asset leaf", () => {
    expect(isNoteNode(asset("img", "sha256:abc"))).toBe(false)
  })

  it("is false for null/undefined", () => {
    expect(isNoteNode(null)).toBe(false)
    expect(isNoteNode(undefined)).toBe(false)
  })
})

describe("findNode", () => {
  it("finds the root itself with an empty path", () => {
    const tree = folder("root", [])
    expect(findNode(tree, "root")).toEqual({ node: tree, path: [] })
  })

  it("finds a nested node and reports its index path", () => {
    const target = note("b")
    const tree = folder("root", [note("a"), folder("sub", [target])])
    const { node, path } = findNode(tree, "b")
    expect(node).toBe(target)
    expect(path).toEqual([1, 0])
  })

  it("returns null node and empty path when not found", () => {
    const tree = folder("root", [note("a")])
    expect(findNode(tree, "missing")).toEqual({ node: null, path: [] })
  })
})

describe("updateAtPath", () => {
  it("applies the updater to the root when path is empty", () => {
    const tree = folder("root", [])
    const next = updateAtPath(tree, [], (n) => ({ ...n, name: "renamed" }))
    expect(next.name).toBe("renamed")
  })

  it("applies the updater to a nested node without mutating siblings", () => {
    const tree = folder("root", [note("a"), folder("sub", [note("b")])])
    const next = updateAtPath(tree, [1, 0], (n) => ({ ...n, name: "renamed" }))
    expect((next.children![1].children![0]).name).toBe("renamed")
    expect(next.children![0]).toBe(tree.children![0])
  })
})

describe("insertNode", () => {
  it("throws when parentId is null", () => {
    const tree = folder("root", [])
    expect(() => insertNode(tree, null, note("a"))).toThrow()
  })

  it("prepends the new node into the target folder's children", () => {
    const tree = folder("root", [note("existing")])
    const next = insertNode(tree, "root", note("new"))
    expect(next.children!.map((c) => c.id)).toEqual(["new", "existing"])
  })

  it("is a no-op when the parent isn't found", () => {
    const tree = folder("root", [])
    const next = insertNode(tree, "missing", note("a"))
    expect(next).toEqual(tree)
  })

  it("is a no-op when the parent isn't a folder", () => {
    const tree = folder("root", [note("a")])
    const next = insertNode(tree, "a", note("b"))
    expect(next).toEqual(tree)
  })
})

describe("collectLeaves", () => {
  it("splits notes and image assets across nested folders", () => {
    const tree = folder("root", [
      note("note-a"),
      asset("img-node", "sha256:1"),
      folder("sub", [note("note-b"), asset("img-node-2", "sha256:2")]),
    ])
    expect(collectLeaves(tree)).toEqual({
      noteIds: ["note-a", "note-b"],
      assetIds: ["sha256:1", "sha256:2"],
    })
  })

  it("returns empty arrays for a null/undefined node", () => {
    expect(collectLeaves(null)).toEqual({ noteIds: [], assetIds: [] })
    expect(collectLeaves(undefined)).toEqual({ noteIds: [], assetIds: [] })
  })

  it("treats a single note leaf as its own singleton result", () => {
    expect(collectLeaves(note("solo"))).toEqual({ noteIds: ["solo"], assetIds: [] })
  })
})

describe("collectSharedNotes", () => {
  it("includes only notes with view/edit link access, skipping restricted and assets", () => {
    const tree = folder("root", [
      note("shared-view", { linkAccess: "view" }),
      note("shared-edit", { linkAccess: "edit" }),
      note("restricted", { linkAccess: "restricted" }),
      note("unset"),
      asset("img", "sha256:1", { linkAccess: "view" }),
      folder("sub", [note("nested-shared", { linkAccess: "view" })]),
    ])

    expect(collectSharedNotes(tree)).toEqual([
      { id: "shared-view", name: "shared-view", linkAccess: "view" },
      { id: "shared-edit", name: "shared-edit", linkAccess: "edit" },
      { id: "nested-shared", name: "nested-shared", linkAccess: "view" },
    ])
  })

  it("returns an empty array for a null/undefined node", () => {
    expect(collectSharedNotes(null)).toEqual([])
  })
})

describe("collectNoteEntries", () => {
  it("excludes the root's own name from ancestors but includes nested folder names", () => {
    const tree = folder("notebook-name", [
      note("top"),
      folder("Work", [note("nested")]),
    ])

    expect(collectNoteEntries(tree)).toEqual([
      { id: "top", name: "top", path: [] },
      { id: "nested", name: "nested", path: ["Work"] },
    ])
  })

  it("also skips a nested hidden-root folder's own name", () => {
    const tree = folder("root", [
      folder("hidden", [note("a")], { hiddenRoot: true }),
    ])
    expect(collectNoteEntries(tree)).toEqual([{ id: "a", name: "a", path: [] }])
  })

  it("skips image assets and falls back to 'Untitled' for an unnamed note", () => {
    const tree = folder("root", [
      asset("img", "sha256:1"),
      note("a", { name: "" }),
    ])
    expect(collectNoteEntries(tree)).toEqual([{ id: "a", name: "Untitled", path: [] }])
  })
})

describe("collectFolderEntries", () => {
  it("includes the notebook root as '/' plus every nested folder with its ancestor path", () => {
    const tree = folder("root", [
      note("a"),
      folder("Work", [folder("Nested", [note("b")])]),
    ])

    expect(collectFolderEntries(tree)).toEqual([
      { id: "root", name: "/", path: [] },
      { id: "Work", name: "Work", path: [] },
      { id: "Nested", name: "Nested", path: ["Work"] },
    ])
  })
})

describe("deleteNode", () => {
  it("removes a top-level node", () => {
    const tree = folder("root", [note("a"), note("b")])
    const next = deleteNode(tree, "a")
    expect(next.children!.map((c) => c.id)).toEqual(["b"])
  })

  it("removes a deeply nested node", () => {
    const tree = folder("root", [folder("sub", [note("a"), note("b")])])
    const next = deleteNode(tree, "a")
    expect(next.children![0].children!.map((c) => c.id)).toEqual(["b"])
  })

  it("refuses to delete the root node itself", () => {
    const tree = folder("root", [note("a")])
    const next = deleteNode(tree, "root")
    expect(next).toBe(tree)
  })
})

describe("moveNode", () => {
  it("moves a note into a different folder and expands the destination", () => {
    const tree = folder("root", [note("a"), folder("dest", [])])
    const next = moveNode(tree, "a", "dest")
    const dest = findNode(next, "dest").node!
    expect(dest.expanded).toBe(true)
    expect(dest.children!.map((c) => c.id)).toEqual(["a"])
    expect(findNode(next, "a").path).not.toEqual([])
  })

  it("is a no-op when id or parentId is null", () => {
    const tree = folder("root", [note("a")])
    expect(moveNode(tree, null, "root")).toBe(tree)
    expect(moveNode(tree, "a", null)).toBe(tree)
  })

  it("is a no-op when asked to move the root", () => {
    const tree = folder("root", [folder("dest", [])])
    expect(moveNode(tree, "root", "dest")).toBe(tree)
  })

  it("is a no-op when id and parentId are the same", () => {
    const tree = folder("root", [folder("a", [])])
    expect(moveNode(tree, "a", "a")).toBe(tree)
  })

  it("is a no-op when the destination doesn't exist or isn't a folder", () => {
    const tree = folder("root", [note("a"), note("b")])
    expect(moveNode(tree, "a", "missing")).toBe(tree)
    expect(moveNode(tree, "a", "b")).toBe(tree)
  })

  it("refuses to move a folder into itself or one of its own descendants", () => {
    const tree = folder("root", [folder("parent", [folder("child", [])])])
    expect(moveNode(tree, "parent", "child")).toBe(tree)
    expect(moveNode(tree, "parent", "parent")).toBe(tree)
  })

  it("is a no-op when dropping onto the folder the node already belongs to", () => {
    const tree = folder("root", [folder("dest", [note("a")])])
    expect(moveNode(tree, "a", "dest")).toBe(tree)
  })
})

describe("renameNode", () => {
  it("renames a node and stamps modifiedAt", () => {
    const tree = folder("root", [note("a")])
    const next = renameNode(tree, "a", "new-name")
    const renamed = findNode(next, "a").node!
    expect(renamed.name).toBe("new-name")
    expect(renamed.modifiedAt).toBeTypeOf("number")
  })

  it("is a no-op when the node isn't found", () => {
    const tree = folder("root", [])
    expect(renameNode(tree, "missing", "x")).toBe(tree)
  })
})

describe("setExpanded", () => {
  it("sets the expanded flag on the target folder", () => {
    const tree = folder("root", [folder("sub", [])])
    const next = setExpanded(tree, "sub", true)
    expect(findNode(next, "sub").node!.expanded).toBe(true)
  })

  it("is a no-op when the node isn't found", () => {
    const tree = folder("root", [])
    expect(setExpanded(tree, "missing", true)).toBe(tree)
  })
})

describe("collapseAll", () => {
  it("collapses every expanded folder, nested or not", () => {
    const tree = folder("root", [
      folder("a", [folder("b", [], { expanded: true })], { expanded: true }),
    ], { expanded: true })

    const next = collapseAll(tree)
    expect(next.expanded).toBe(false)
    expect(next.children![0].expanded).toBe(false)
    expect(next.children![0].children![0].expanded).toBe(false)
  })

  it("returns the same reference when nothing was expanded", () => {
    const tree = folder("root", [folder("a", [note("x")])])
    expect(collapseAll(tree)).toBe(tree)
  })

  it("leaves note leaves untouched", () => {
    const tree = folder("root", [note("a")], { expanded: true })
    const next = collapseAll(tree)
    expect(next.children![0]).toBe(tree.children![0])
  })
})

describe("setNodeLinkAccess", () => {
  it("sets linkAccess and derives isShared", () => {
    const tree = folder("root", [note("a")])
    const next = setNodeLinkAccess(tree, "a", "view")
    const updated = findNode(next, "a").node!
    expect(updated.linkAccess).toBe("view")
    expect(updated.isShared).toBe(true)
  })

  it("derives isShared=false for restricted access", () => {
    const tree = folder("root", [note("a", { linkAccess: "view", isShared: true })])
    const next = setNodeLinkAccess(tree, "a", "restricted")
    expect(findNode(next, "a").node!.isShared).toBe(false)
  })

  it("is a no-op when nothing actually changes", () => {
    const tree = folder("root", [note("a", { linkAccess: "view", isShared: true })])
    expect(setNodeLinkAccess(tree, "a", "view")).toBe(tree)
  })

  it("is a no-op for folders and image assets", () => {
    const tree = folder("root", [folder("f", []), asset("img", "sha256:1")])
    expect(setNodeLinkAccess(tree, "f", "view")).toBe(tree)
    expect(setNodeLinkAccess(tree, "img", "view")).toBe(tree)
  })
})

describe("touchNodeModifiedAt", () => {
  it("stamps modifiedAt on a note", () => {
    const tree = folder("root", [note("a")])
    const next = touchNodeModifiedAt(tree, "a", 12345)
    expect(findNode(next, "a").node!.modifiedAt).toBe(12345)
  })

  it("is a no-op for folders and image assets", () => {
    const tree = folder("root", [folder("f", []), asset("img", "sha256:1")])
    expect(touchNodeModifiedAt(tree, "f", 1)).toBe(tree)
    expect(touchNodeModifiedAt(tree, "img", 1)).toBe(tree)
  })
})

describe("findAssetNode", () => {
  it("finds a nested asset node by assetId and reports its path", () => {
    const target = asset("img", "sha256:abc")
    const tree = folder("root", [folder("Assets", [target])])
    const found = findAssetNode(tree, "sha256:abc")
    expect(found?.node).toBe(target)
    expect(found?.path).toEqual([0, 0])
  })

  it("returns null when no matching asset exists", () => {
    const tree = folder("root", [note("a")])
    expect(findAssetNode(tree, "sha256:missing")).toBeNull()
  })
})

describe("ensureAssetNode", () => {
  it("inserts a new asset, creating the Assets folder if it doesn't exist", () => {
    const tree = folder("root", [])
    const next = ensureAssetNode(tree, "root", "assets-folder", asset("img", "sha256:1"))
    const assetsFolder = findNode(next, "assets-folder").node!
    expect(assetsFolder.isFolder).toBe(true)
    expect(assetsFolder.name).toBe("Assets")
    expect(assetsFolder.children!.map((c) => c.id)).toEqual(["img"])
  })

  it("inserts into an existing Assets folder without creating a duplicate", () => {
    const tree = folder("root", [folder("assets-folder", [])])
    const next = ensureAssetNode(tree, "root", "assets-folder", asset("img", "sha256:1"))
    expect(next.children).toHaveLength(1)
    expect(next.children![0].children!.map((c) => c.id)).toEqual(["img"])
  })

  it("returns the tree unchanged when the same content hash is already present", () => {
    const existing = asset("existing-img", "sha256:1", { name: "sha256:1" })
    const tree = folder("root", [folder("assets-folder", [existing])])
    const next = ensureAssetNode(tree, "root", "assets-folder", asset("new-img", "sha256:1"))
    expect(next).toEqual(tree)
    expect(findNode(next, "new-img").node).toBeNull()
  })

  it("renames the existing entry when it still has an auto-generated name", () => {
    // isGeneratedAssetName matches against the *short* hash (chars 7-15 of
    // "sha256:..."), so the fixture's assetId needs to be long enough to slice.
    const assetId = "sha256:12345678abcdef"
    const existing = asset("existing-img", assetId, { name: "12345678" })
    const tree = folder("root", [folder("assets-folder", [existing])])
    const next = ensureAssetNode(
      tree,
      "root",
      "assets-folder",
      asset("new-img", assetId, { name: "diagram.png" }),
    )
    expect(findNode(next, "existing-img").node!.name).toBe("diagram.png")
  })

  it("does not rename an existing entry that already has a user-given name", () => {
    const assetId = "sha256:12345678abcdef"
    const existing = asset("existing-img", assetId, { name: "my-custom-name.png" })
    const tree = folder("root", [folder("assets-folder", [existing])])
    const next = ensureAssetNode(
      tree,
      "root",
      "assets-folder",
      asset("new-img", assetId, { name: "diagram.png" }),
    )
    expect(next).toEqual(tree)
  })
})

describe("upsertChildren", () => {
  it("replaces a folder's children wholesale", () => {
    const tree = folder("root", [folder("f", [note("old")])])
    const next = upsertChildren(tree, "f", [note("new-a"), note("new-b")])
    expect(findNode(next, "f").node!.children!.map((c) => c.id)).toEqual(["new-a", "new-b"])
  })

  it("is a no-op when the node isn't found", () => {
    const tree = folder("root", [])
    expect(upsertChildren(tree, "missing", [note("a")])).toBe(tree)
  })
})

describe("flattenTree / buildTreeFromFlat", () => {
  it("round-trips a nested tree through the flat id -> record shape", () => {
    const tree = folder("root", [
      note("a", { modifiedAt: 5 }),
      folder("sub", [note("b"), asset("img", "sha256:1")]),
    ])

    const flat = flattenTree(tree)

    expect(flat.get("root")?.parentId).toBeNull()
    expect(flat.get("a")?.parentId).toBe("root")
    expect(flat.get("sub")?.parentId).toBe("root")
    expect(flat.get("b")?.parentId).toBe("sub")
    expect(flat.get("img")?.assetId).toBe("sha256:1")

    expect(buildTreeFromFlat(flat)).toEqual(tree)
  })

  it("finds the root by parentId null regardless of what the root's own id is", () => {
    const tree = folder("shared-root-xyz", [note("a")])
    expect(buildTreeFromFlat(flattenTree(tree))).toEqual(tree)
  })

  it("returns undefined for an empty flat map", () => {
    expect(buildTreeFromFlat(new Map())).toBeUndefined()
  })

  it("skips a node whose parent record is missing (dangling reference)", () => {
    const flat = flattenTree(folder("root", [note("a")]))
    flat.delete("a")
    // Add a leftover child record pointing at a parent that no longer
    // resolves to anything reachable from the root - shouldn't happen in
    // practice, but must not crash or resurrect a phantom node.
    flat.set("orphan", { parentId: "nonexistent", name: "orphan", isFolder: false })
    expect(buildTreeFromFlat(flat)).toEqual(folder("root", []))
  })
})

describe("diffFlatTrees", () => {
  it("reports newly added and removed nodes", () => {
    const prev = flattenTree(folder("root", [note("a")]))
    const next = flattenTree(folder("root", [note("b")]))

    const { upserts, deletes } = diffFlatTrees(prev, next)

    expect(upserts.map(([id]) => id).sort()).toEqual(["b"])
    expect(deletes).toEqual(["a"])
  })

  it("only reports nodes whose fields actually changed", () => {
    const prev = flattenTree(folder("root", [note("a"), note("b")]))
    const next = flattenTree(folder("root", [{ ...note("a"), name: "renamed" }, note("b")]))

    const { upserts, deletes } = diffFlatTrees(prev, next)

    expect(upserts.map(([id]) => id)).toEqual(["a"])
    expect(deletes).toEqual([])
  })

  it("reports a move as a single upsert of the moved node's parentId", () => {
    const prev = flattenTree(folder("root", [note("a"), folder("dest", [])]))
    const next = flattenTree(folder("root", [folder("dest", [note("a")])]))

    const { upserts, deletes } = diffFlatTrees(prev, next)

    expect(upserts).toEqual([["a", expect.objectContaining({ parentId: "dest" })]])
    expect(deletes).toEqual([])
  })

  it("reports nothing for two structurally identical trees", () => {
    const tree = folder("root", [note("a"), folder("sub", [note("b")])])
    const { upserts, deletes } = diffFlatTrees(flattenTree(tree), flattenTree(clone(tree)))
    expect(upserts).toEqual([])
    expect(deletes).toEqual([])
  })
})
