const IMAGE_ASSET_DB = "synk-image-assets"
const IMAGE_ASSET_DB_VERSION = 1
const IMAGE_ASSET_STORE = "assets"

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

  if (!(await hasImageAsset(assetId))) {
    await writeImageAsset({
      id: assetId,
      blob,
      mimeType: blob.type || "application/octet-stream",
      size: blob.size,
      createdAt: Date.now(),
    })
  }

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
