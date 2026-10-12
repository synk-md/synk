/**
 * The app's side of images at the relay: publishing what this device holds,
 * and fetching what it does not, into the same local store the editor reads.
 */

import { getImageAsset, storeReceivedImageAsset, type StoredImageAsset } from "@/lib/image-assets"
import { sniffImageMimeType } from "@/lib/p2p-image-assets"

import { fetchImage, httpBlobClient, publishImage, type BlobClient } from "./images"
import { encryptedSyncEnabled, relaySettings } from "./note-relay"

export function relayBlobs(): BlobClient | null {
  const { url } = relaySettings()
  return encryptedSyncEnabled() && url ? httpBlobClient(url) : null
}

// Per session: an image confirmed at the relay once need not be asked about
// again on every note open.
const published = new Set<string>()

/** Put an image this device holds where members can reach it. Quietly does nothing otherwise. */
export async function publishHeldImage(notebookId: string, assetId: string): Promise<void> {
  const key = `${notebookId}\n${assetId}`
  const blobs = relayBlobs()
  if (!blobs || published.has(key)) return
  const asset = await getImageAsset(assetId)
  if (!asset) return
  const outcome = await publishImage(blobs, notebookId, assetId, new Uint8Array(await asset.blob.arrayBuffer()))
  if (outcome !== "refused") published.add(key)
}

/** Fetch an image from the relay into this device's store. Undefined when it is not there. */
export async function fetchRelayImage(
  notebookId: string,
  assetId: string,
): Promise<StoredImageAsset | undefined> {
  const blobs = relayBlobs()
  if (!blobs) return undefined
  const bytes = await fetchImage(blobs, notebookId, assetId)
  // The type is read off the bytes, never taken from whoever uploaded them.
  const type = bytes ? sniffImageMimeType(bytes) : null
  if (!bytes || !type) return undefined
  published.add(`${notebookId}\n${assetId}`)
  return storeReceivedImageAsset(assetId, new Blob([bytes as BlobPart], { type }))
}
