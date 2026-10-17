/**
 * An image through a running relay's HTTP endpoints, as two devices would
 * move it: one publishes, the other fetches - never online together.
 *
 * Run `pnpm relay` first. Exits non-zero unless the image arrives intact and
 * the relay holds nothing readable.
 */

import { fetchImage, httpBlobClient, imageChannel, publishImage, renewImages } from "../src/lib/workspace/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const NOTEBOOK = `images-${String(Date.now())}`

// A photo-sized image: random bytes behind a PNG header and a marker that
// must never be readable at the relay.
const marker = new TextEncoder().encode("PRIVATE-HOLIDAY-PHOTO")
const image = new Uint8Array(3 * 1024 * 1024)
crypto.getRandomValues(image.subarray(0, 65536))
image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
image.set(marker, 64)
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", image))
const assetId = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`

const relay = httpBlobClient(URL)

let started = performance.now()
const outcome = await publishImage(relay, NOTEBOOK, assetId, image)
const publishMs = performance.now() - started
console.log(`published ${String(image.length / 1024 / 1024)} MB: ${outcome} in ${publishMs.toFixed(0)} ms`)
console.log(`published again: ${await publishImage(relay, NOTEBOOK, assetId, image)}`)

started = performance.now()
const fetched = await fetchImage(relay, NOTEBOOK, assetId)
const fetchMs = performance.now() - started
const intact = !!fetched && fetched.length === image.length && fetched.every((byte, index) => byte === image[index])
console.log(`fetched on another device: ${intact ? "intact" : "WRONG"} in ${fetchMs.toFixed(0)} ms`)

const { locator } = await imageChannel(NOTEBOOK, assetId)
const raw = new Uint8Array(await (await fetch(`${URL.replace(/^ws/, "http")}/blobs/${locator}`)).arrayBuffer())
const readable = new TextDecoder("latin1").decode(raw).includes("PRIVATE-HOLIDAY-PHOTO")
console.log(`readable at the relay: ${String(readable)}`)

const elsewhere = await fetchImage(relay, `${NOTEBOOK}-other`, assetId)
console.log(`reachable through another notebook: ${String(!!elsewhere)}`)

// Renewed, it stays; one the relay never had is named back, for whoever holds it to put back.
const unknown = `sha256:${"0".repeat(64)}`
const missing = await renewImages(relay, NOTEBOOK, [assetId, unknown])
const renewed = missing.length === 1 && missing[0] === unknown
console.log(`renewed, and told what it lacks: ${String(renewed)}`)

const ok = outcome === "stored" && intact && !readable && !elsewhere && renewed
console.log(ok ? "OK" : "FAILED")
process.exit(ok ? 0 : 1)
