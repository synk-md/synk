import { describe, expect, it } from "vitest"
import {
  createImageAssetId,
  getImageAsset,
  hasImageAsset,
  storeImageAsset,
  storeReceivedImageAsset,
  deleteImageAsset,
} from "./image-assets"

// The module under test keys everything off a single, fixed IndexedDB
// database name, so every test shares one (fake-indexeddb-backed) database
// for this file. Tests use distinct blob content to get distinct content
// hashes rather than resetting the database between tests.
function blobOf(content: string, type = "image/png"): Blob {
  return new Blob([content], { type })
}

describe("createImageAssetId", () => {
  it("derives a deterministic sha256: id from the blob's content", async () => {
    const id = await createImageAssetId(blobOf("hello-world-1"))
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await createImageAssetId(blobOf("hello-world-1"))).toBe(id)
  })

  it("produces different ids for different content", async () => {
    const a = await createImageAssetId(blobOf("content-a"))
    const b = await createImageAssetId(blobOf("content-b"))
    expect(a).not.toBe(b)
  })

  it("is independent of the blob's mime type", async () => {
    const a = await createImageAssetId(blobOf("same-bytes", "image/png"))
    const b = await createImageAssetId(blobOf("same-bytes", "image/jpeg"))
    expect(a).toBe(b)
  })
})

describe("storeImageAsset / getImageAsset / hasImageAsset", () => {
  it("stores a blob and makes it retrievable by its content-hash id", async () => {
    const blob = blobOf("store-me-1")
    const { assetId } = await storeImageAsset(blob)

    expect(await hasImageAsset(assetId)).toBe(true)
    const stored = await getImageAsset(assetId)
    expect(stored?.id).toBe(assetId)
    expect(stored?.mimeType).toBe("image/png")
    expect(stored?.size).toBe(blob.size)
    expect(stored?.createdAt).toBeTypeOf("number")
  })

  it("falls back to application/octet-stream when the blob has no type", async () => {
    const blob = blobOf("store-me-untyped", "")
    const { assetId } = await storeImageAsset(blob)
    expect((await getImageAsset(assetId))?.mimeType).toBe("application/octet-stream")
  })

  it("is idempotent for identical content: storing twice still resolves to one working asset", async () => {
    const blob = blobOf("store-me-twice")
    const first = await storeImageAsset(blob)
    const second = await storeImageAsset(blobOf("store-me-twice"))

    expect(second.assetId).toBe(first.assetId)
    expect((await getImageAsset(first.assetId))?.size).toBe(blob.size)
  })

  it("returns undefined/false for an asset that was never stored", async () => {
    const missingId = await createImageAssetId(blobOf("never-stored"))
    expect(await getImageAsset(missingId)).toBeUndefined()
    expect(await hasImageAsset(missingId)).toBe(false)
  })
})

describe("storeReceivedImageAsset", () => {
  it("stores the asset under the given id when the content hash matches", async () => {
    const blob = blobOf("received-ok")
    const expectedId = await createImageAssetId(blob)

    const stored = await storeReceivedImageAsset(expectedId, blob)

    expect(stored.id).toBe(expectedId)
    expect(await hasImageAsset(expectedId)).toBe(true)
  })

  it("rejects and stores nothing when the content hash doesn't match the claimed id", async () => {
    const blob = blobOf("tampered-content")
    const wrongId = await createImageAssetId(blobOf("something-else"))

    await expect(storeReceivedImageAsset(wrongId, blob)).rejects.toThrow(/integrity check failed/)
    expect(await hasImageAsset(wrongId)).toBe(false)
  })
})

describe("deleteImageAsset", () => {
  it("removes a stored asset", async () => {
    const { assetId } = await storeImageAsset(blobOf("delete-me"))
    expect(await hasImageAsset(assetId)).toBe(true)

    await deleteImageAsset(assetId)

    expect(await hasImageAsset(assetId)).toBe(false)
  })

  it("is a safe no-op for an id that was never stored", async () => {
    const missingId = await createImageAssetId(blobOf("never-stored-delete"))
    await expect(deleteImageAsset(missingId)).resolves.toBeUndefined()
  })
})
