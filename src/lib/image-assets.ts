const IMAGE_ASSET_DB = "synk-image-assets"
const IMAGE_ASSET_DB_VERSION = 1
const IMAGE_ASSET_STORE = "assets"
// When each stored image was first seen unused, so it is only deleted once it
// has stayed that way for a while. A database of its own, so adding it did not
// mean upgrading one an open tab holds.
const UNUSED_DB = "synk-image-unused"
const UNUSED_STORE = "unused"

export type ImageAssetReference = {
  assetId: string
}

export type StoredImageAsset = {
  id: string
  blob: Blob
  mimeType: string
  size: number
  createdAt: number
}

let databasePromise: Promise<IDBDatabase> | null = null
let unusedPromise: Promise<IDBDatabase> | null = null

function openUnusedDatabase(): Promise<IDBDatabase> {
  unusedPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(UNUSED_DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(UNUSED_STORE, { keyPath: "id" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      unusedPromise = null
      reject(request.error ?? new Error("Failed to open the unused image database"))
    }
  })
  return unusedPromise
}

function openImageAssetDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_ASSET_DB, IMAGE_ASSET_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(IMAGE_ASSET_STORE)) {
        database.createObjectStore(IMAGE_ASSET_STORE, { keyPath: "id" })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error("Failed to open the image asset database"))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error("Opening the image asset database was blocked"))
    }
  })

  return databasePromise
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function createImageAssetId(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return `sha256:${bytesToHex(new Uint8Array(digest))}`
}

export async function getImageAsset(
  assetId: string,
): Promise<StoredImageAsset | undefined> {
  const database = await openImageAssetDatabase()

  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_ASSET_STORE, "readonly")
    const request = transaction.objectStore(IMAGE_ASSET_STORE).get(assetId)

    request.onsuccess = () => resolve(request.result as StoredImageAsset | undefined)
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to load image asset ${assetId}`))
    }
  })
}

export async function hasImageAsset(assetId: string): Promise<boolean> {
  const database = await openImageAssetDatabase()

  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_ASSET_STORE, "readonly")
    const request = transaction.objectStore(IMAGE_ASSET_STORE).count(assetId)

    request.onsuccess = () => resolve(request.result > 0)
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to check image asset ${assetId}`))
    }
  })
}

async function writeImageAsset(asset: StoredImageAsset): Promise<void> {
  const database = await openImageAssetDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IMAGE_ASSET_STORE, "readwrite")
    transaction.objectStore(IMAGE_ASSET_STORE).put(asset)

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(transaction.error ?? new Error(`Failed to store image asset ${asset.id}`))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error(`Storing image asset ${asset.id} was aborted`))
    }
  })
}

export async function storeImageAsset(blob: Blob): Promise<ImageAssetReference> {
  const assetId = await createImageAssetId(blob)

  // Written even when already held: the fresh time tells a cleanup running
  // now that it is in use again.
  await writeImageAsset({
    id: assetId,
    blob,
    mimeType: blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: Date.now(),
  })

  return { assetId }
}

export async function storeReceivedImageAsset(
  assetId: string,
  blob: Blob,
): Promise<StoredImageAsset> {
  const actualAssetId = await createImageAssetId(blob)
  if (actualAssetId !== assetId) {
    throw new Error(`Image asset integrity check failed for ${assetId}`)
  }

  const asset: StoredImageAsset = {
    id: assetId,
    blob,
    mimeType: blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: Date.now(),
  }

  await writeImageAsset(asset)
  return asset
}

export async function deleteImageAsset(assetId: string): Promise<void> {
  const database = await openImageAssetDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IMAGE_ASSET_STORE, "readwrite")
    transaction.objectStore(IMAGE_ASSET_STORE).delete(assetId)

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(transaction.error ?? new Error(`Failed to delete image asset ${assetId}`))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error(`Deleting image asset ${assetId} was aborted`))
    }
  })
}

/** Every stored image's id and when it was stored, without reading the images. */
export async function listImageAssets(): Promise<{ id: string; createdAt: number }[]> {
  const database = await openImageAssetDatabase()

  return await new Promise((resolve, reject) => {
    const listed: { id: string; createdAt: number }[] = []
    const transaction = database.transaction(IMAGE_ASSET_STORE, "readonly")
    const request = transaction.objectStore(IMAGE_ASSET_STORE).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve(listed)
      const asset = cursor.value as StoredImageAsset
      listed.push({ id: asset.id, createdAt: asset.createdAt })
      cursor.continue()
    }
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to list image assets"))
    }
  })
}

/** When each image seen unused was first seen so. */
export async function readUnusedSince(): Promise<Map<string, number>> {
  const database = await openUnusedDatabase()

  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(UNUSED_STORE, "readonly")
    const request = transaction.objectStore(UNUSED_STORE).getAll()
    request.onsuccess = () => {
      const records = request.result as { id: string; since: number }[]
      resolve(new Map(records.map((record) => [record.id, record.since])))
    }
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to read unused image marks"))
    }
  })
}

/** Records images first seen unused at `since`, and forgets the ones in use again. */
export async function writeUnusedSince(mark: readonly string[], since: number, unmark: readonly string[]): Promise<void> {
  if (mark.length === 0 && unmark.length === 0) return
  const database = await openUnusedDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(UNUSED_STORE, "readwrite")
    const store = transaction.objectStore(UNUSED_STORE)
    for (const id of mark) store.put({ id, since })
    for (const id of unmark) store.delete(id)

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Failed to record unused images"))
    }
  })
}
