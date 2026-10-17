import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { assetsFolderIdFor, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { initCurrentDevice, resetCurrentDevice, resetDeviceIdentityCache } from "@/lib/identity"
import { getImageAsset, hasImageAsset, storeImageAsset } from "@/lib/image-assets"
import { BlobStore, handleBlobRequest } from "@/lib/relay"
import {
  createNotebookIndexDoc,
  deleteNoteFromIndexedDB,
  flushPersistence,
  getOrCreateYDoc,
  readNotebookIndexTree,
  writeNotebookIndexTree,
} from "@/lib/yjs-utils"

import { claimNewNotebook } from "./claim"
import { fetchImage, httpBlobClient, type BlobClient } from "./images"
import { IMAGE_GRACE_MS, imagesShownBy, releaseImages, upkeepImages } from "./image-upkeep"

const relay: { client: BlobClient | null; shared: Set<string> } = { client: null, shared: new Set() }
vi.mock("./note-images", () => ({ relayBlobs: () => relay.client }))
// fake-indexeddb hands a Blob back without its methods.
const blobs = new Map<string, Blob>()
vi.mock("@/lib/image-assets", async (original) => {
  const actual = await original<typeof import("@/lib/image-assets")>()
  return {
    ...actual,
    getImageAsset: async (assetId: string) => {
      const asset = await actual.getImageAsset(assetId)
      const blob = blobs.get(assetId)
      return asset && blob ? { ...asset, blob } : asset
    },
  }
})
vi.mock("./admission", async (original) => ({
  ...(await original<typeof import("./admission")>()),
  hasAdmittedMembers: (doc: Y.Doc) => [...relay.shared].some((id) => doc === createNotebookIndexDoc(id).doc),
}))

function aRelay(): BlobStore {
  const store = new BlobStore()
  relay.client = httpBlobClient("ws://relay.test", ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : (init?.body as Uint8Array | undefined)
    const response = handleBlobRequest(store, {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
    return Promise.resolve(new Response(response?.body ?? null, { status: response?.status ?? 404, headers: response?.headers }))
  }) as typeof fetch)
  return store
}

let counter = 0
const unique = (name: string) => `${name}${String((counter += 1))}x${String(Date.now())}`

async function anImage(name: string): Promise<string> {
  const blob = new Blob([unique(name)], { type: "image/png" })
  const { assetId } = await storeImageAsset(blob)
  blobs.set(assetId, blob)
  return assetId
}

async function writeNote(notebookId: string, noteId: string, assetIds: string[]) {
  const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
  await idb.whenSynced
  doc.transact(() => {
    doc.getMap("meta").set("title", noteId)
    for (const assetId of assetIds) {
      const image = new Y.XmlElement("image")
      image.setAttribute("assetId", assetId)
      doc.getXmlFragment("default").push([image])
    }
  })
  await flushPersistence(idb)
}

const entry = (id: string, assetId: string): TreeNode => ({ id, name: id, isFolder: false, assetId, listed: true })

async function aNotebook(options: { notes: Record<string, string[]>; entries?: TreeNode[]; claimed?: boolean }) {
  const notebookId = unique("nb")
  if (options.claimed !== false) await claimNewNotebook(notebookId, "Travel")
  const index = createNotebookIndexDoc(notebookId)
  await index.idb.whenSynced
  const root: TreeNode = {
    id: `root_${notebookId}`,
    name: "Travel",
    isFolder: true,
    children: [
      ...Object.keys(options.notes).map((noteId) => ({ id: noteId, name: noteId, isFolder: false })),
      { id: assetsFolderIdFor(notebookId), name: "Assets", isFolder: true, children: options.entries ?? [] },
    ],
  }
  writeNotebookIndexTree(index, readNotebookIndexTree(index).flat, root, "test")
  for (const [noteId, assetIds] of Object.entries(options.notes)) await writeNote(notebookId, noteId, assetIds)
  return { notebookId, index, root }
}

/** What deleting a note in the file browser does. */
async function deleteNote(notebook: Awaited<ReturnType<typeof aNotebook>>, noteId: string) {
  const shown = await imagesShownBy(notebook.notebookId, [noteId])
  const { index, root } = notebook
  writeNotebookIndexTree(index, readNotebookIndexTree(index).flat, { ...root, children: root.children?.filter((child) => child.id !== noteId) }, "test")
  await deleteNoteFromIndexedDB(notebook.notebookId, noteId)
  return releaseImages(shown, notebook.notebookId)
}

beforeEach(async () => {
  relay.client = null
  relay.shared.clear()
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
})

describe("deleting a note", () => {
  it("deletes the images only it showed, and their Assets entries, and keeps the rest", async () => {
    const temple = await anImage("temple")
    const shrine = await anImage("shrine")
    const notebook = await aNotebook({
      notes: { kyoto: [temple], osaka: [temple, shrine] },
      entries: [entry("templeEntry", temple), entry("shrineEntry", shrine)],
    })

    await deleteNote(notebook, "osaka")

    expect(await hasImageAsset(shrine)).toBe(false)
    expect(await hasImageAsset(temple)).toBe(true)
    expect(notebook.index.nodes.has("shrineEntry")).toBe(false)
    expect(notebook.index.nodes.has("templeEntry")).toBe(true)
  })

  it("keeps an image a note in another notebook shows", async () => {
    const temple = await anImage("temple")
    await aNotebook({ notes: { slides: [temple] } })
    const travel = await aNotebook({ notes: { kyoto: [temple] }, entries: [entry("templeEntry", temple)] })

    await deleteNote(travel, "kyoto")

    expect(await hasImageAsset(temple)).toBe(true)
    // Nothing in this notebook shows it any more.
    expect(travel.index.nodes.has("templeEntry")).toBe(false)
  })

  it("keeps an image someone filed as a file of their own", async () => {
    const temple = await anImage("temple")
    const notebook = await aNotebook({
      notes: { kyoto: [temple] },
      entries: [{ id: "photo", name: "photo", isFolder: false, assetId: temple }],
    })

    await deleteNote(notebook, "kyoto")

    expect(await hasImageAsset(temple)).toBe(true)
    expect(notebook.index.nodes.has("photo")).toBe(true)
  })

  it("leaves the tree of a notebook nobody has claimed alone - this device may only be looking at it", async () => {
    const temple = await anImage("temple")
    const notebook = await aNotebook({
      notes: { kyoto: [temple] },
      entries: [entry("templeEntry", temple)],
      claimed: false,
    })

    await deleteNote(notebook, "kyoto")

    expect(notebook.index.nodes.has("templeEntry")).toBe(true)
  })
})

describe("the daily run", () => {
  it("deletes an image only once it has stayed unused for the grace period", async () => {
    const temple = await anImage("temple")
    const now = Date.now()

    await upkeepImages({ now, renew: false })
    expect(await hasImageAsset(temple)).toBe(true)

    await upkeepImages({ now: now + IMAGE_GRACE_MS - 1, renew: false })
    expect(await hasImageAsset(temple)).toBe(true)

    await upkeepImages({ now: now + IMAGE_GRACE_MS, renew: false })
    expect(await hasImageAsset(temple)).toBe(false)
  })

  it("starts the grace period over for an image shown again", async () => {
    const temple = await anImage("temple")
    const now = Date.now()
    await upkeepImages({ now, renew: false })

    const notebook = await aNotebook({ notes: { kyoto: [temple] } })
    await upkeepImages({ now: now + 1, renew: false })
    await deleteNoteFromIndexedDB(notebook.notebookId, "kyoto")

    await upkeepImages({ now: now + IMAGE_GRACE_MS, renew: false })
    expect(await hasImageAsset(temple)).toBe(true)
  })

  it("renews at the relay what a shared notebook shows, and puts back what the relay lost", async () => {
    const store = aRelay()
    const temple = await anImage("temple")
    const notebook = await aNotebook({ notes: { kyoto: [temple] } })
    relay.shared.add(notebook.notebookId)

    const result = await upkeepImages({ renew: true })

    expect(result?.republished).toBe(1)
    const bytes = await fetchImage(relay.client!, notebook.notebookId, temple)
    const held = await getImageAsset(temple)
    expect(bytes?.length).toBe(held?.size)
    expect(store.locatorsHeld).toBe(1)
  })

  it("puts nothing of a notebook shared with nobody at the relay", async () => {
    const store = aRelay()
    const temple = await anImage("temple")
    await aNotebook({ notes: { kyoto: [temple] } })

    await upkeepImages({ renew: true })

    expect(store.locatorsHeld).toBe(0)
  })
})
