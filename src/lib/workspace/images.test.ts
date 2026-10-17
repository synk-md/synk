import { describe, expect, it } from "vitest"

import { BlobStore, handleBlobRequest, MAX_RENEW, type BlobQuota } from "@/lib/relay"

import { fetchImage, httpBlobClient, imageChannel, openImage, publishImage, renewImages, sealImage } from "./images"

/** The relay's own handler behind `fetch`, so client and server are tested together. */
function relayFetch(store: BlobStore): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const body =
      typeof init?.body === "string"
        ? new TextEncoder().encode(init.body)
        : init?.body
          ? new Uint8Array(init.body as Uint8Array)
          : undefined
    const response = handleBlobRequest(store, {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      ...(body ? { body } : {}),
    })
    if (!response) return Promise.resolve(new Response(null, { status: 404 }))
    return Promise.resolve(
      new Response(response.body ?? null, { status: response.status, headers: response.headers }),
    )
  }) as typeof fetch
}

// jsdom and Node's fetch each have their own Uint8Array, which deep equality
// tells apart. What matters is the bytes.
const decoded = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : bytes)

function aRelay(quota?: Partial<BlobQuota>) {
  const clock = { now: 0 }
  const store = new BlobStore(quota ? { ...new BlobStore().quota, ...quota } : undefined, () => clock.now)
  return { store, clock, client: httpBlobClient("ws://relay.test:4455", relayFetch(store)) }
}

async function anImage(text = "a picture of Kyoto") {
  const bytes = new TextEncoder().encode(text)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const assetId = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  return { bytes, assetId }
}

describe("images through the relay", () => {
  it("reach another device that knows which image it wants", async () => {
    const { client } = aRelay()
    const { bytes, assetId } = await anImage()

    expect(await publishImage(client, "travel", assetId, bytes)).toBe("stored")
    expect(decoded(await fetchImage(client, "travel", assetId))).toBe(decoded(bytes))
  })

  it("are unreadable to the relay, which cannot tell what or whose they are", async () => {
    const { store, client } = aRelay()
    const { bytes, assetId } = await anImage()
    await publishImage(client, "travel", assetId, bytes)

    const { locator } = await imageChannel("travel", assetId)
    const held = new TextDecoder().decode(store.get(locator))
    expect(held).not.toContain("Kyoto")
    expect(locator).not.toContain("travel")
    expect(locator).not.toContain(assetId.slice(7, 20))
  })

  /** The key comes from the notebook as well as the image. */
  it("cannot be fetched or opened by way of another notebook", async () => {
    const { client } = aRelay()
    const { bytes, assetId } = await anImage()
    await publishImage(client, "travel", assetId, bytes)

    expect(await fetchImage(client, "elsewhere", assetId)).toBeUndefined()
    const sealed = await sealImage(bytes, await imageChannel("travel", assetId))
    expect(await openImage(sealed, await imageChannel("elsewhere", assetId), assetId)).toBeUndefined()
  })

  /** Convergent: two devices holding the same image produce the same ciphertext. */
  it("is stored once however many devices publish it", async () => {
    const { store, client } = aRelay()
    const { bytes, assetId } = await anImage()
    await publishImage(client, "travel", assetId, bytes)

    expect(await publishImage(client, "travel", assetId, bytes)).toBe("present")
    const { locator } = await imageChannel("travel", assetId)
    expect(store.count(locator)).toBe(1)
  })

  /** Anyone may upload. Garbage put there first must not stand in the way of the real one. */
  it("skips a bogus upload and finds the real image behind it", async () => {
    const { store, client } = aRelay()
    const { bytes, assetId } = await anImage()
    const channel = await imageChannel("travel", assetId)
    store.put(channel.locator, new TextEncoder().encode("not the image at all"))
    await client.put(channel.locator, await sealImage(bytes, channel))

    expect(decoded(await fetchImage(client, "travel", assetId))).toBe(decoded(bytes))
  })

  /** A different image sealed under the right key still fails the hash check. */
  it("refuses bytes that are not the image asked for", async () => {
    const { bytes: other } = await anImage("something else entirely")
    const { assetId } = await anImage()
    const channel = await imageChannel("travel", assetId)

    expect(await openImage(await sealImage(other, channel), channel, assetId)).toBeUndefined()
  })

  it("refuses a tampered ciphertext", async () => {
    const { bytes, assetId } = await anImage()
    const channel = await imageChannel("travel", assetId)
    const sealed = await sealImage(bytes, channel)
    sealed[0] ^= 0xff

    expect(await openImage(sealed, channel, assetId)).toBeUndefined()
  })

  it("comes back empty, not broken, when the relay does not have it", async () => {
    const { client } = aRelay()
    const { assetId } = await anImage()
    expect(await fetchImage(client, "travel", assetId)).toBeUndefined()
  })
})

describe("the relay's blob endpoints", () => {
  const locator = "A".repeat(43)
  const call = (store: BlobStore, method: string, url: string, body?: Uint8Array) =>
    handleBlobRequest(store, { method, url, ...(body ? { body } : {}) })

  it("answers a browser's preflight, so the app can reach it from another origin", () => {
    const response = call(new BlobStore(), "OPTIONS", `/blobs/${locator}`)!
    expect(response.status).toBe(204)
    expect(response.headers["access-control-allow-origin"]).toBe("*")
    expect(response.headers["access-control-expose-headers"]).toContain("x-synk-candidates")
  })

  it("leaves anything that is not a blob to the caller", () => {
    expect(call(new BlobStore(), "GET", "/health")).toBeNull()
  })

  it("refuses a locator that is not one", () => {
    expect(call(new BlobStore(), "GET", "/blobs/..%2Fetc")!.status).toBe(400)
  })

  it("lets a stored ciphertext be cached for good", () => {
    const store = new BlobStore()
    call(store, "PUT", `/blobs/${locator}`, new Uint8Array([1, 2, 3]))
    const response = call(store, "GET", `/blobs/${locator}`)!
    expect(response.status).toBe(200)
    expect(response.headers["cache-control"]).toContain("immutable")
    expect(response.body).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("refuses what is too large, and stops taking candidates once full", () => {
    const store = new BlobStore({ maxBlobBytes: 4, maxCandidates: 2, maxTotalBytes: 1_000 })
    expect(call(store, "PUT", `/blobs/${locator}`, new Uint8Array(5))!.status).toBe(413)
    expect(call(store, "PUT", `/blobs/${locator}`, new Uint8Array([1]))!.status).toBe(201)
    expect(call(store, "PUT", `/blobs/${locator}`, new Uint8Array([1]))!.status).toBe(200)
    expect(call(store, "PUT", `/blobs/${locator}`, new Uint8Array([2]))!.status).toBe(201)
    expect(call(store, "PUT", `/blobs/${locator}`, new Uint8Array([3]))!.status).toBe(507)
    expect(call(store, "HEAD", `/blobs/${locator}`)!.headers["x-synk-candidates"]).toBe("2")
  })
})

describe("images nobody renews", () => {
  const DAY = 24 * 60 * 60 * 1000
  const TTL = 90 * DAY

  it("age out at the relay, while one a member renews stays", async () => {
    const { store, clock, client } = aRelay()
    const kept = await anImage("a picture of Kyoto")
    const dropped = await anImage("a picture of Osaka")
    await publishImage(client, "travel", kept.assetId, kept.bytes)
    await publishImage(client, "travel", dropped.assetId, dropped.bytes)

    clock.now = 60 * DAY
    expect(await renewImages(client, "travel", [kept.assetId])).toEqual([])
    clock.now = 120 * DAY
    expect(store.sweep(TTL)).toBe(1)

    expect(decoded(await fetchImage(client, "travel", kept.assetId))).toBe(decoded(kept.bytes))
    expect(await fetchImage(client, "travel", dropped.assetId)).toBeUndefined()
    expect(store.bytesHeld).toBe((await sealImage(kept.bytes, await imageChannel("travel", kept.assetId))).length)
  })

  it("stay while members keep fetching them", async () => {
    const { store, clock, client } = aRelay()
    const { bytes, assetId } = await anImage()
    await publishImage(client, "travel", assetId, bytes)

    clock.now = 60 * DAY
    await fetchImage(client, "travel", assetId)
    clock.now = 120 * DAY
    expect(store.sweep(TTL)).toBe(0)
  })

  it("are named back when lost, so a device holding them can put them back", async () => {
    const { store, clock, client } = aRelay()
    const { bytes, assetId } = await anImage()
    await publishImage(client, "travel", assetId, bytes)
    clock.now = 120 * DAY
    store.sweep(TTL)

    expect(await renewImages(client, "travel", [assetId])).toEqual([assetId])
    expect(await publishImage(client, "travel", assetId, bytes)).toBe("stored")
    expect(await renewImages(client, "travel", [assetId])).toEqual([])
  })

  it("cannot be deleted by anyone, a removed member included", () => {
    const store = new BlobStore()
    const locator = "A".repeat(43)
    handleBlobRequest(store, { method: "PUT", url: `/blobs/${locator}`, body: new Uint8Array([1]) })
    expect(handleBlobRequest(store, { method: "DELETE", url: `/blobs/${locator}` })!.status).toBe(405)
    expect(store.count(locator)).toBe(1)
  })

  it("refuses a renewal that is not a list of locators, or too long a one", () => {
    const store = new BlobStore()
    const renew = (body: unknown, method = "POST") =>
      handleBlobRequest(store, {
        method,
        url: "/blobs/renew",
        body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
      })!.status
    expect(renew({ locators: ["A".repeat(43)] })).toBe(200)
    expect(renew({ locators: ["A".repeat(43)] }, "GET")).toBe(405)
    expect(renew("not json")).toBe(400)
    expect(renew({ locators: "A".repeat(43) })).toBe(400)
    expect(renew({ locators: ["../etc"] })).toBe(400)
    expect(renew({ locators: Array.from({ length: MAX_RENEW + 1 }, () => "A".repeat(43)) })).toBe(400)
  })
})
