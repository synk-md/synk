/**
 * A notebook's images, sealed and kept at the relay.
 *
 * Each image's key is derived from the notebook and the image's own hash, and
 * that hash appears nowhere but inside note content, which is sealed under the
 * epoch keys. So who can open an image is exactly who can read a note that
 * shows it: a new member gets every image their baseline references with no
 * re-wrapping, and a removed member never learns the hash of anything added
 * after they left.
 *
 * Convergent, so the same image uploaded twice is one ciphertext. The known
 * weakness of that is confirmation: someone who already has an image and the
 * notebook id can tell whether that notebook holds it. Nobody else can.
 */

import { aeadDecrypt, aeadEncrypt, deriveKey, toBase64Url, utf8, type Bytes } from "@/lib/crypto"
import { MAX_RENEW } from "@/lib/relay"

export interface ImageChannel {
  /** Where the relay files it. Neither the notebook nor the hash can be read off it. */
  locator: string
  key: Bytes
  nonce: Bytes
}

export async function imageChannel(notebookId: string, assetId: string): Promise<ImageChannel> {
  const secret = utf8(`synk/notebook/${notebookId}/image/${assetId}`)
  return {
    locator: toBase64Url(await deriveKey(secret, "synk/image-locator/v1", 32)),
    key: await deriveKey(secret, "synk/image-key/v1", 32),
    // Fixed per image, which is safe only because the key is too: one key and
    // one nonce only ever seal these exact bytes.
    nonce: await deriveKey(secret, "synk/image-nonce/v1", 12),
  }
}

export async function sealImage(bytes: Bytes, channel: ImageChannel): Promise<Bytes> {
  return aeadEncrypt(channel.key, channel.nonce, bytes, utf8(channel.locator))
}

async function sha256Id(bytes: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/** The image, or undefined for anything that is not it - whoever uploaded it. */
export async function openImage(
  ciphertext: Bytes,
  channel: ImageChannel,
  assetId: string,
): Promise<Bytes | undefined> {
  try {
    const bytes = await aeadDecrypt(channel.key, channel.nonce, ciphertext, utf8(channel.locator))
    return (await sha256Id(bytes)) === assetId ? bytes : undefined
  } catch {
    return undefined
  }
}

export interface BlobClient {
  has(locator: string): Promise<boolean>
  /** False when the relay refused it. */
  put(locator: string, bytes: Bytes): Promise<boolean>
  get(locator: string, candidate: number): Promise<{ bytes: Bytes; count: number } | undefined>
  /** Keeps these from ageing out. The ones the relay does not hold, or undefined when it refused. */
  renew(locators: readonly string[]): Promise<string[] | undefined>
}

/** The relay's blob endpoints, from its socket address. */
export function httpBlobClient(relayUrl: string, fetchImpl: typeof fetch = fetch): BlobClient {
  const base = relayUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "")
  const at = (locator: string) => `${base}/blobs/${locator}`
  return {
    has: async (locator) => {
      const response = await fetchImpl(at(locator), { method: "HEAD" })
      return response.ok
    },
    put: async (locator, bytes) => {
      const response = await fetchImpl(at(locator), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes as BodyInit,
      })
      return response.ok
    },
    get: async (locator, candidate) => {
      const response = await fetchImpl(`${at(locator)}?candidate=${String(candidate)}`)
      const count = Number(response.headers.get("x-synk-candidates") ?? "0")
      if (!response.ok) return undefined
      return { bytes: new Uint8Array(await response.arrayBuffer()), count }
    },
    renew: async (locators) => {
      const response = await fetchImpl(`${base}/blobs/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locators }),
      })
      if (!response.ok) return undefined
      const { missing } = (await response.json()) as { missing?: unknown }
      return Array.isArray(missing) ? missing.filter((locator): locator is string => typeof locator === "string") : undefined
    },
  }
}

/**
 * Tell the relay these images are still shown, so it keeps them. Returns the
 * ones it no longer holds - lost or aged out - for a device holding them to
 * put back.
 */
export async function renewImages(
  client: BlobClient,
  notebookId: string,
  assetIds: readonly string[],
): Promise<string[]> {
  const byLocator = new Map<string, string>()
  for (const assetId of assetIds) byLocator.set((await imageChannel(notebookId, assetId)).locator, assetId)
  const locators = [...byLocator.keys()]
  const missing: string[] = []
  for (let start = 0; start < locators.length; start += MAX_RENEW) {
    const absent = await client.renew(locators.slice(start, start + MAX_RENEW))
    if (!absent) throw new Error("The relay refused to renew images.")
    for (const locator of absent) {
      const assetId = byLocator.get(locator)
      if (assetId) missing.push(assetId)
    }
  }
  return missing
}

/** Put an image this device holds where members can reach it. Skips one already there. */
export async function publishImage(
  client: BlobClient,
  notebookId: string,
  assetId: string,
  bytes: Bytes,
): Promise<"stored" | "present" | "refused"> {
  const channel = await imageChannel(notebookId, assetId)
  if (await client.has(channel.locator)) return "present"
  return (await client.put(channel.locator, await sealImage(bytes, channel))) ? "stored" : "refused"
}

/**
 * Fetch and open an image, trying each candidate the relay holds until one is
 * the image asked for. One request in the ordinary case.
 */
export async function fetchImage(
  client: BlobClient,
  notebookId: string,
  assetId: string,
): Promise<Bytes | undefined> {
  const channel = await imageChannel(notebookId, assetId)
  let count = 1
  for (let candidate = 0; candidate < count; candidate += 1) {
    const held = await client.get(channel.locator, candidate)
    if (!held) return undefined
    count = held.count
    const bytes = await openImage(held.bytes, channel, assetId)
    if (bytes) return bytes
  }
  return undefined
}
