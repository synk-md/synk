import { describe, expect, it } from "vitest"

import { assetsFolderIdFor, type TreeNode } from "@/components/custom-ui/file-browser/tree"

import { planImageCleanup, type CleanupInput, type NotebookView } from "./image-cleanup"

const DAY = 24 * 60 * 60 * 1000
const GRACE = 30 * DAY
const NOW = 100 * DAY

const note = (id: string): TreeNode => ({ id, name: id, isFolder: false })
const listedEntry = (id: string, assetId: string): TreeNode => ({ id, name: id, isFolder: false, assetId, listed: true })
const file = (id: string, assetId: string): TreeNode => ({ id, name: id, isFolder: false, assetId })

function tree(notebookId: string, children: TreeNode[], assets: TreeNode[] = []): TreeNode {
  return {
    id: `root_${notebookId}`,
    name: notebookId,
    isFolder: true,
    children: [...children, { id: assetsFolderIdFor(notebookId), name: "Assets", isFolder: true, children: assets }],
  }
}

function notebook(notebookId: string, root: TreeNode | undefined, notes: Record<string, string[]>, writable = true): NotebookView {
  return { notebookId, root, notes: new Map(Object.entries(notes)), writable }
}

function plan(input: Partial<CleanupInput>) {
  return planImageCleanup({
    notebooks: [],
    strays: [],
    stored: [],
    unusedSince: new Map(),
    now: NOW,
    graceMs: GRACE,
    ...input,
  })
}

describe("deleting images nobody uses", () => {
  it("keeps an image a note shows", () => {
    const result = plan({
      notebooks: [notebook("travel", tree("travel", [note("kyoto")]), { kyoto: ["sha256:temple"] })],
      stored: ["sha256:temple"],
    })
    expect(result.deleteImages).toEqual([])
    expect(result.markUnused).toEqual([])
  })

  it("only notes an unused image the first time, so undoing an edit still finds it", () => {
    const result = plan({ stored: ["sha256:temple"] })
    expect(result.deleteImages).toEqual([])
    expect(result.markUnused).toEqual(["sha256:temple"])
  })

  it("deletes an image once it has stayed unused for the grace period, not before", () => {
    const almost = plan({ stored: ["sha256:temple"], unusedSince: new Map([["sha256:temple", NOW - GRACE + 1]]) })
    expect(almost.deleteImages).toEqual([])
    expect(almost.markUnused).toEqual([])

    const due = plan({ stored: ["sha256:temple"], unusedSince: new Map([["sha256:temple", NOW - GRACE]]) })
    expect(due.deleteImages).toEqual(["sha256:temple"])
    expect(due.unmarkUnused).toEqual(["sha256:temple"])
  })

  it("forgets that an image was unused once a note shows it again", () => {
    const result = plan({
      notebooks: [notebook("travel", tree("travel", [note("kyoto")]), { kyoto: ["sha256:temple"] })],
      stored: ["sha256:temple"],
      unusedSince: new Map([["sha256:temple", NOW - GRACE]]),
    })
    expect(result.deleteImages).toEqual([])
    expect(result.unmarkUnused).toEqual(["sha256:temple"])
  })

  it("deletes a released image at once when nothing else uses it", () => {
    const result = plan({
      notebooks: [notebook("travel", tree("travel", [note("osaka")]), { osaka: [] })],
      stored: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]), notebookId: "travel" },
    })
    expect(result.deleteImages).toEqual(["sha256:temple"])
  })

  it("keeps a released image another notebook's note still shows - the store is shared", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", []), {}),
        notebook("work", tree("work", [note("slides")]), { slides: ["sha256:temple"] }),
      ],
      stored: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]), notebookId: "travel" },
    })
    expect(result.deleteImages).toEqual([])
  })

  it("keeps a released image someone put in a notebook as a file of its own", () => {
    const result = plan({
      notebooks: [notebook("travel", tree("travel", [file("photo", "sha256:temple")]), {})],
      stored: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]) },
    })
    expect(result.deleteImages).toEqual([])
  })

  it("counts notes no tree lists any more", () => {
    const result = plan({
      stored: ["sha256:temple"],
      strays: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]) },
    })
    expect(result.deleteImages).toEqual([])
  })
})

describe("the Assets folder's entries", () => {
  it("go once no note in the notebook shows the image, and take the image with them", () => {
    const result = plan({
      notebooks: [notebook("travel", tree("travel", [note("osaka")], [listedEntry("entry", "sha256:temple")]), { osaka: [] })],
      stored: ["sha256:temple"],
      unusedSince: new Map([["sha256:temple", NOW - GRACE]]),
    })
    expect(result.removeEntries).toEqual([{ notebookId: "travel", nodeId: "entry", assetId: "sha256:temple" }])
    expect(result.deleteImages).toEqual(["sha256:temple"])
  })

  it("stay while a note shows the image", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", [note("kyoto")], [listedEntry("entry", "sha256:temple")]), { kyoto: ["sha256:temple"] }),
      ],
      stored: ["sha256:temple"],
    })
    expect(result.removeEntries).toEqual([])
    expect(result.inUse.get("travel")).toEqual(new Set(["sha256:temple"]))
  })

  it("stay, and keep the image, while the tree lists a note this device does not hold", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", [note("osaka"), note("nara")], [listedEntry("entry", "sha256:temple")]), { osaka: [] }),
      ],
      stored: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]) },
    })
    expect(result.removeEntries).toEqual([])
    expect(result.deleteImages).toEqual([])
  })

  it("are left to a device that may change the tree", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", [note("osaka")], [listedEntry("entry", "sha256:temple")]), { osaka: [] }, false),
      ],
    })
    expect(result.removeEntries).toEqual([])
  })

  it("count as a file of its own once moved out of the Assets folder", () => {
    const root = tree("travel", [note("osaka"), listedEntry("moved", "sha256:temple")])
    const result = plan({
      notebooks: [notebook("travel", root, { osaka: [] })],
      stored: ["sha256:temple"],
      released: { assetIds: new Set(["sha256:temple"]) },
    })
    expect(result.removeEntries).toEqual([])
    expect(result.deleteImages).toEqual([])
  })

  it("go in one notebook while another notebook's note still shows the image, which stays", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", [], [listedEntry("entry", "sha256:temple")]), {}),
        notebook("work", tree("work", [note("slides")]), { slides: ["sha256:temple"] }),
      ],
      stored: ["sha256:temple"],
    })
    expect(result.removeEntries).toEqual([{ notebookId: "travel", nodeId: "entry", assetId: "sha256:temple" }])
    expect(result.deleteImages).toEqual([])
  })

  it("after a delete, go only for what it released, in its notebook", () => {
    const result = plan({
      notebooks: [
        notebook("travel", tree("travel", [], [listedEntry("a", "sha256:temple"), listedEntry("b", "sha256:shrine")]), {}),
        notebook("work", tree("work", [], [listedEntry("c", "sha256:temple")]), {}),
      ],
      released: { assetIds: new Set(["sha256:temple"]), notebookId: "travel" },
    })
    expect(result.removeEntries).toEqual([{ notebookId: "travel", nodeId: "a", assetId: "sha256:temple" }])
  })
})
