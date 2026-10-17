/**
 * Encrypted images, over plain HTTP beside the socket.
 *
 * Images are big and immutable, which is everything the sync socket is not
 * built for: a 5 MB frame would hold up every envelope behind it, and base64
 * inside JSON adds a third. Here they are binary bodies, fetched in parallel,
 * and cacheable forever because a locator names one ciphertext.
 *
 * The relay cannot read them and cannot name them: a locator is derived from
 * the notebook and the image's hash, neither of which it learns. Anyone may
 * upload, because a reader checks the decrypted bytes against the hash it was
 * looking for - so a locator keeps a few candidates rather than letting the
 * first upload, which might be garbage, stand in the way of the real one.
 *
 * Nobody deletes a blob, since the relay cannot tell who may. A blob nobody
 * has asked about or renewed for long enough is dropped instead: member
 * devices renew the images their notes still show, so one no note shows ages
 * out, and nobody - a removed member included - can take one away early.
 */

/** 32 bytes, base64url. */
export const LOCATOR_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface BlobQuota {
  maxBlobBytes: number
  /** Distinct uploads kept per locator. */
  maxCandidates: number
  maxTotalBytes: number
}

export const DEFAULT_BLOB_QUOTA: BlobQuota = {
  // Images are capped at 5 MB before encryption; the tag adds 16 bytes.
  maxBlobBytes: 5 * 1024 * 1024 + 1024,
  maxCandidates: 4,
  maxTotalBytes: 512 * 1024 * 1024,
}

export type PutResult = "stored" | "duplicate" | "too-large" | "full"

/** Locators renewed in one request. */
export const MAX_RENEW = 1024

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

export class BlobStore {
  private readonly blobs = new Map<string, Uint8Array[]>()
  /** When each locator was last stored, fetched, asked about or renewed. */
  private readonly touched = new Map<string, number>()
  private total = 0
  readonly quota: BlobQuota
  private readonly now: () => number

  constructor(quota: BlobQuota = DEFAULT_BLOB_QUOTA, now: () => number = Date.now) {
    this.quota = quota
    this.now = now
  }

  put(locator: string, bytes: Uint8Array): PutResult {
    if (bytes.length > this.quota.maxBlobBytes) return "too-large"
    const held = this.blobs.get(locator) ?? []
    if (held.some((candidate) => sameBytes(candidate, bytes))) return "duplicate"
    if (held.length >= this.quota.maxCandidates) return "full"
    if (this.total + bytes.length > this.quota.maxTotalBytes) return "full"
    this.blobs.set(locator, [...held, bytes])
    this.total += bytes.length
    this.touch(locator)
    return "stored"
  }

  /** Keeps a held locator from ageing out. */
  touch(locator: string): void {
    if (this.blobs.has(locator)) this.touched.set(locator, this.now())
  }

  /** Renews every held locator given; returns the ones not held. */
  renew(locators: readonly string[]): string[] {
    const missing = []
    for (const locator of locators) {
      if (this.blobs.has(locator)) this.touch(locator)
      else missing.push(locator)
    }
    return missing
  }

  /** Drops every locator untouched for longer than `olderThanMs`. Returns how many. */
  sweep(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs
    let dropped = 0
    for (const [locator, at] of this.touched) {
      if (at >= cutoff) continue
      for (const candidate of this.blobs.get(locator) ?? []) this.total -= candidate.length
      this.blobs.delete(locator)
      this.touched.delete(locator)
      dropped += 1
    }
    return dropped
  }

  get(locator: string, candidate = 0): Uint8Array | undefined {
    return this.blobs.get(locator)?.[candidate]
  }

  count(locator: string): number {
    return this.blobs.get(locator)?.length ?? 0
  }

  get bytesHeld(): number {
    return this.total
  }

  get locatorsHeld(): number {
    return this.blobs.size
  }
}

export interface BlobRequest {
  method: string
  /** Path and query, as the request line has them. */
  url: string
  body?: Uint8Array
}

export interface BlobResponse {
  status: number
  headers: Record<string, string>
  body?: Uint8Array
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-expose-headers": "x-synk-candidates",
}

const reply = (status: number, extra: Record<string, string> = {}, body?: Uint8Array): BlobResponse => ({
  status,
  headers: { ...CORS, ...extra },
  ...(body ? { body } : {}),
})

/** Null when the request is not for a blob, so the caller can handle it. */
export function handleBlobRequest(store: BlobStore, request: BlobRequest): BlobResponse | null {
  const url = new URL(request.url, "http://relay")
  if (url.pathname === "/blobs/renew") return handleRenew(store, request)
  const match = /^\/blobs\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  const locator = match[1]
  if (!LOCATOR_PATTERN.test(locator)) return reply(400)

  switch (request.method) {
    case "OPTIONS":
      return reply(204)

    case "HEAD": {
      store.touch(locator)
      const count = store.count(locator)
      return reply(count > 0 ? 200 : 404, { "x-synk-candidates": String(count) })
    }

    case "GET": {
      const candidate = Number(url.searchParams.get("candidate") ?? "0")
      if (!Number.isSafeInteger(candidate) || candidate < 0) return reply(400)
      store.touch(locator)
      const bytes = store.get(locator, candidate)
      const count = store.count(locator)
      if (!bytes) return reply(404, { "x-synk-candidates": String(count) })
      return reply(
        200,
        {
          "content-type": "application/octet-stream",
          "x-synk-candidates": String(count),
          // One locator, one candidate index, one ciphertext - for good.
          "cache-control": "public, max-age=31536000, immutable",
        },
        bytes,
      )
    }

    case "PUT": {
      store.touch(locator)
      const result = store.put(locator, request.body ?? new Uint8Array())
      const status = { stored: 201, duplicate: 200, "too-large": 413, full: 507 }[result]
      return reply(status, { "x-synk-candidates": String(store.count(locator)) })
    }

    default:
      return reply(405)
  }
}

/** `POST /blobs/renew` with `{ "locators": [...] }`: answers with the ones it does not hold. */
function handleRenew(store: BlobStore, request: BlobRequest): BlobResponse {
  if (request.method === "OPTIONS") return reply(204)
  if (request.method !== "POST") return reply(405)
  let locators: unknown
  try {
    locators = (JSON.parse(new TextDecoder().decode(request.body ?? new Uint8Array())) as { locators?: unknown }).locators
  } catch {
    return reply(400)
  }
  if (
    !Array.isArray(locators) ||
    locators.length > MAX_RENEW ||
    !locators.every((locator): locator is string => typeof locator === "string" && LOCATOR_PATTERN.test(locator))
  ) {
    return reply(400)
  }
  const missing = store.renew(locators)
  return reply(200, { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify({ missing })))
}
