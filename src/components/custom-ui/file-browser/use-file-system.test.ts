import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useFileSystem } from "./use-file-system"
import { findNode, type TreeNode } from "./tree"

// useFileSystem memoizes its initial tree off the *reference identity* of
// initialRoot/initialRoots, then re-syncs from it in an effect. Passing a
// freshly-constructed literal inline inside the renderHook callback creates
// a new reference on every re-render, which retriggers that effect and
// loops forever (this OOM'd the process the first time). Always build these
// fixtures as a `const` outside the renderHook callback.

function note(id: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, isFolder: false, ...overrides }
}

function folder(id: string, children: TreeNode[] = [], overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, isFolder: true, children, ...overrides }
}

describe("useFileSystem: initial tree shape", () => {
  it("defaults to an empty synthetic hidden root", () => {
    const { result } = renderHook(() => useFileSystem())
    expect(result.current.tree).toEqual({
      id: "__root__", name: "Workspace", isFolder: true, expanded: true, children: [], hiddenRoot: true,
    })
  })

  it("uses initialRoot as-is when given", () => {
    const root = folder("nb-root", [note("a")])
    const { result } = renderHook(() => useFileSystem({ initialRoot: root }))
    expect(result.current.tree).toEqual(root)
  })

  it("wraps initialRoots in a synthetic hidden root", () => {
    const roots = [folder("nb1", []), folder("nb2", [])]
    const { result } = renderHook(() => useFileSystem({ initialRoots: roots }))
    expect(result.current.tree.hiddenRoot).toBe(true)
    expect(result.current.tree.children).toBe(roots)
  })

  it("uses the controlled root prop over initialRoot/initialRoots", () => {
    const controlled = folder("controlled-root", [note("x")])
    const ignoredRoot = folder("ignored", [])
    const { result } = renderHook(() =>
      useFileSystem({ root: controlled, initialRoot: ignoredRoot }),
    )
    expect(result.current.tree).toEqual(controlled)
  })
})

describe("useFileSystem: controlled root syncing", () => {
  it("adopts a new root prop and drops the selection if it no longer exists there", async () => {
    const rootA = folder("root", [note("a")])
    const { result, rerender } = renderHook(({ root }) => useFileSystem({ root }), {
      initialProps: { root: rootA },
    })

    await act(async () => {
      await result.current.select("a")
    })
    expect(result.current.selectedId).toBe("a")

    const rootB = folder("root", [note("b")])
    rerender({ root: rootB })

    expect(result.current.tree).toEqual(rootB)
    expect(result.current.selectedId).toBeNull()
  })

  it("keeps the selection when the selected node still exists in the new root", async () => {
    const rootA = folder("root", [note("a")])
    const { result, rerender } = renderHook(({ root }) => useFileSystem({ root }), {
      initialProps: { root: rootA },
    })

    await act(async () => {
      await result.current.select("a")
    })

    const rootB = folder("root", [note("a", { name: "renamed-elsewhere" })])
    rerender({ root: rootB })

    expect(result.current.selectedId).toBe("a")
  })
})

describe("useFileSystem: mutations notify onRootChange", () => {
  it("createNode inserts a node with generated id/timestamps and returns the id", () => {
    const onRootChange = vi.fn()
    const initialRoot = folder("root", [])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onRootChange }))

    let newId!: string | null
    act(() => {
      newId = result.current.createNode("root", { name: "New Note", isFolder: false })
    })

    expect(newId).toBeTruthy()
    const created = findNode(result.current.tree, newId).node!
    expect(created.name).toBe("New Note")
    expect(created.createdAt).toBeTypeOf("number")
    expect(created.modifiedAt).toBeTypeOf("number")
    expect(onRootChange).toHaveBeenCalledWith(result.current.tree)
  })

  it("createNode uses an explicitly given id instead of generating one", () => {
    const initialRoot = folder("root", [])
    const { result } = renderHook(() => useFileSystem({ initialRoot }))
    let returnedId!: string | null
    act(() => {
      returnedId = result.current.createNode("root", { id: "explicit-id", name: "x", isFolder: false })
    })
    expect(returnedId).toBe("explicit-id")
  })

  it("rename/remove/move mutate the tree and notify onRootChange", () => {
    const onRootChange = vi.fn()
    const initialRoot = folder("root", [note("a"), folder("dest", [])])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onRootChange }))

    act(() => result.current.rename("a", "renamed"))
    expect(findNode(result.current.tree, "a").node!.name).toBe("renamed")

    act(() => result.current.move("a", "dest"))
    expect(findNode(result.current.tree, "dest").node!.children!.map((c) => c.id)).toEqual(["a"])

    act(() => result.current.remove("a"))
    expect(findNode(result.current.tree, "a").node).toBeNull()

    expect(onRootChange).toHaveBeenCalledTimes(3)
  })

  it("does not call onRootChange when a mutation is a no-op", () => {
    const onRootChange = vi.fn()
    const initialRoot = folder("root", [note("a")])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onRootChange }))

    act(() => result.current.rename("missing-id", "x"))

    expect(onRootChange).not.toHaveBeenCalled()
  })

  it("setRoots wraps plain roots in a synthetic hidden root, or replaces children if already hidden", () => {
    const { result } = renderHook(() => useFileSystem())

    act(() => result.current.setRoots([folder("nb1", []), folder("nb2", [])]))
    expect(result.current.tree.hiddenRoot).toBe(true)
    expect(result.current.tree.children!.map((c) => c.id)).toEqual(["nb1", "nb2"])

    act(() => result.current.setRoots([folder("nb3", [])]))
    expect(result.current.tree.children!.map((c) => c.id)).toEqual(["nb3"])
  })

  it("setRoot replaces the whole tree with a single visible root", () => {
    const { result } = renderHook(() => useFileSystem())
    const newRoot = folder("visible-root", [note("a")])

    act(() => result.current.setRoot(newRoot))

    expect(result.current.tree).toEqual(newRoot)
  })
})

describe("useFileSystem: expandFolder / collapseAll", () => {
  it("sets a folder's expanded flag without a fetcher", async () => {
    const initialRoot = folder("root", [folder("sub", [])])
    const { result } = renderHook(() => useFileSystem({ initialRoot }))

    await act(async () => {
      await result.current.expandFolder("sub", true)
    })

    expect(findNode(result.current.tree, "sub").node!.expanded).toBe(true)
  })

  it("lazily fetches children exactly once via fetchChildren when expanding a folder with no children yet", async () => {
    const lazyFolder: TreeNode = { id: "lazy", name: "lazy", isFolder: true } // children undefined
    const initialRoot = folder("root", [lazyFolder])
    const fetchChildren = vi.fn().mockResolvedValue([note("fetched-a")])
    const { result } = renderHook(() => useFileSystem({ initialRoot, fetchChildren, authToken: "tok" }))

    await act(async () => {
      await result.current.expandFolder("lazy", true)
    })

    expect(fetchChildren).toHaveBeenCalledWith("lazy", "tok")
    expect(findNode(result.current.tree, "lazy").node!.children!.map((c) => c.id)).toEqual(["fetched-a"])
    expect(findNode(result.current.tree, "lazy").node!.expanded).toBe(true)

    await act(async () => {
      await result.current.expandFolder("lazy", true)
    })
    expect(fetchChildren).toHaveBeenCalledTimes(1)
  })

  it("collapseAll collapses every expanded folder", () => {
    const tree = folder("root", [folder("a", [], { expanded: true })], { expanded: true })
    const { result } = renderHook(() => useFileSystem({ initialRoot: tree }))

    act(() => result.current.collapseAll())

    expect(result.current.tree.expanded).toBe(false)
    expect(findNode(result.current.tree, "a").node!.expanded).toBe(false)
  })
})

describe("useFileSystem: select / autosave", () => {
  it("selects a node without calling onAutosave when nothing was modified", async () => {
    const onAutosave = vi.fn()
    const initialRoot = folder("root", [note("a")])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onAutosave }))

    await act(async () => {
      await result.current.select("a")
    })

    expect(result.current.selectedId).toBe("a")
    expect(onAutosave).not.toHaveBeenCalled()
  })

  it("awaits onAutosave before switching selection when the tree was modified", async () => {
    const order: string[] = []
    const onAutosave = vi.fn(async () => {
      order.push("autosave")
    })
    const initialRoot = folder("root", [note("a"), note("b")])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onAutosave }))

    act(() => {
      result.current.rename("a", "modified")
    })

    await act(async () => {
      order.push("select-start")
      await result.current.select("b")
      order.push("select-done")
    })

    expect(order).toEqual(["select-start", "autosave", "select-done"])
    expect(result.current.selectedId).toBe("b")
  })

  it("does not re-trigger autosave on a second select once the modified flag has been cleared", async () => {
    const onAutosave = vi.fn().mockResolvedValue(undefined)
    const initialRoot = folder("root", [note("a"), note("b")])
    const { result } = renderHook(() => useFileSystem({ initialRoot, onAutosave }))

    act(() => result.current.rename("a", "modified"))
    await act(async () => {
      await result.current.select("b")
    })
    expect(onAutosave).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.select("a")
    })
    expect(onAutosave).toHaveBeenCalledTimes(1)
  })
})
