import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { Awareness } from "y-protocols/awareness"
import { P2PImageAssetTransfer } from "./p2p-image-assets"

const { getImageAsset, hasImageAsset, storeReceivedImageAsset } = vi.hoisted(() => ({
  getImageAsset: vi.fn(),
  hasImageAsset: vi.fn(),
  storeReceivedImageAsset: vi.fn(),
}))

vi.mock("@/lib/image-assets", () => ({ getImageAsset, hasImageAsset, storeReceivedImageAsset }))

const FIELD = "synkImageAssetTransfer"
const CHUNK_SIZE = 12 * 1024
const ACK_TIMEOUT_MS = 4_000

// Mirrors ASSET_ID_PATTERN (/^sha256:[0-9a-f]{64}$/) in the module under test.
function assetId(suffix: string): string {
  return `sha256:${suffix.padStart(64, "0")}`
}

function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

// A minimal, single-node stand-in for y-protocols' Awareness: only what
// P2PImageAssetTransfer touches (getStates/getLocalState/setLocalStateField/
// on/off), plus test-only helpers to inject "remote peer" awareness updates
// without needing a second, independently-stateful image-assets store.
class FakeAwareness {
  clientID: number
  private localState: Record<string, unknown> | null = null
  private states = new Map<number, Record<string, unknown> | null>()
  private listeners = new Set<
    (e: { added: number[]; updated: number[]; removed: number[] }) => void
  >()

  constructor(clientID: number) {
    this.clientID = clientID
  }

  getLocalState() {
    return this.localState
  }

  getStates() {
    return this.states
  }

  setLocalStateField(field: string, value: unknown) {
    if (value === null) {
      const next = { ...(this.localState ?? {}) }
      delete next[field]
      this.localState = next
    } else {
      this.localState = { ...(this.localState ?? {}), [field]: value }
    }
    this.states.set(this.clientID, this.localState)
  }

  on(event: string, cb: (e: { added: number[]; updated: number[]; removed: number[] }) => void) {
    if (event === "update") this.listeners.add(cb)
  }

  off(event: string, cb: (e: { added: number[]; updated: number[]; removed: number[] }) => void) {
    if (event === "update") this.listeners.delete(cb)
  }

  // Test helper: simulates a remote peer's awareness state becoming known.
  remoteSetState(remoteClientId: number, state: Record<string, unknown>, kind: "added" | "updated" = "updated") {
    this.states.set(remoteClientId, state)
    this.listeners.forEach((cb) =>
      cb({
        added: kind === "added" ? [remoteClientId] : [],
        updated: kind === "updated" ? [remoteClientId] : [],
        removed: [],
      }),
    )
  }

  lastLocalMessage(): any {
    return this.localState?.[FIELD]
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  getImageAsset.mockReset()
  hasImageAsset.mockReset()
  storeReceivedImageAsset.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("requestAsset", () => {
  it("resolves immediately from the local store without broadcasting anything", async () => {
    const asset = { id: assetId("1"), blob: new Blob(), mimeType: "image/png", size: 0, createdAt: 0 }
    getImageAsset.mockResolvedValue(asset)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    const result = await transfer.requestAsset(assetId("1"))

    expect(result).toBe(asset)
    expect(awareness.lastLocalMessage()).toBeUndefined()
  })

  it("broadcasts a request message when the asset isn't cached locally", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    void transfer.requestAsset(assetId("2"))
    await flush()

    const message = awareness.lastLocalMessage()
    expect(message.kind).toBe("request")
    expect(message.assetId).toBe(assetId("2"))
    expect(message.from).toBe(1)

    transfer.destroy()
  })

  it("shares a single pending request across concurrent calls for the same asset", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const setSpy = vi.spyOn(awareness, "setLocalStateField")
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    void transfer.requestAsset(assetId("3"))
    void transfer.requestAsset(assetId("3"))
    await flush()

    expect(setSpy).toHaveBeenCalledTimes(1)
    transfer.destroy()
  })

  it("resolves with undefined once the request times out with no response", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    const pending = transfer.requestAsset(assetId("4"))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(await pending).toBeUndefined()
  })
})

describe("acting as the responder to a peer's request", () => {
  function requestMessage(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      version: 1,
      nonce: crypto.randomUUID(),
      kind: "request",
      requestId: crypto.randomUUID(),
      from: 2,
      assetId: assetId("5"),
      expiresAt: Date.now() + 120_000,
      ...overrides,
    }
  }

  it("ignores a request for an asset not referenced by this note", async () => {
    hasImageAsset.mockResolvedValue(true)
    const awareness = new FakeAwareness(1)
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => false)

    awareness.remoteSetState(2, { [FIELD]: requestMessage() })
    await vi.advanceTimersByTimeAsync(300)

    expect(hasImageAsset).not.toHaveBeenCalled()
  })

  it("ignores its own broadcast request reflected back by awareness", async () => {
    hasImageAsset.mockResolvedValue(true)
    const awareness = new FakeAwareness(1)
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    awareness.remoteSetState(1, { [FIELD]: requestMessage({ from: 1 }) })
    await vi.advanceTimersByTimeAsync(300)

    expect(hasImageAsset).not.toHaveBeenCalled()
  })

  it("ignores an already-expired request", async () => {
    hasImageAsset.mockResolvedValue(true)
    const awareness = new FakeAwareness(1)
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    awareness.remoteSetState(2, { [FIELD]: requestMessage({ expiresAt: Date.now() - 1 }) })
    await vi.advanceTimersByTimeAsync(300)

    expect(hasImageAsset).not.toHaveBeenCalled()
  })

  it("does nothing further when it doesn't actually hold the asset", async () => {
    hasImageAsset.mockResolvedValue(false)
    const awareness = new FakeAwareness(1)
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    awareness.remoteSetState(2, { [FIELD]: requestMessage() })
    await vi.advanceTimersByTimeAsync(300)

    expect(getImageAsset).not.toHaveBeenCalled()
  })

  it("serves the asset: sends a start message, then sends chunk 0 once acked", async () => {
    const bytes = pngBytes(100)
    const asset = { id: assetId("5"), blob: new Blob([bytes]), mimeType: "image/png", size: bytes.length, createdAt: 0 }
    hasImageAsset.mockResolvedValue(true)
    getImageAsset.mockResolvedValue(asset)

    const awareness = new FakeAwareness(1)
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    const request = requestMessage()
    awareness.remoteSetState(2, { [FIELD]: request })
    // Past the request-handling jitter delay (50-200ms).
    await vi.advanceTimersByTimeAsync(300)

    const start = awareness.lastLocalMessage()
    expect(start.kind).toBe("start")
    expect(start.assetId).toBe(assetId("5"))
    expect(start.size).toBe(bytes.length)
    expect(start.chunkCount).toBe(1)
    expect(start.to).toBe(2)

    // Peer 2 acks the start message (index -1); server should then send chunk 0.
    awareness.remoteSetState(2, {
      [FIELD]: { version: 1, nonce: crypto.randomUUID(), kind: "ack", transferId: start.transferId, from: 2, to: 1, index: -1 },
    })
    await flush()

    const chunk = awareness.lastLocalMessage()
    expect(chunk.kind).toBe("chunk")
    expect(chunk.index).toBe(0)
    expect(chunk.data).toBe(toBase64(bytes))
  })

  it("gives up serving after exhausting ack retries", async () => {
    const bytes = pngBytes(10)
    const asset = { id: assetId("6"), blob: new Blob([bytes]), mimeType: "image/png", size: bytes.length, createdAt: 0 }
    hasImageAsset.mockResolvedValue(true)
    getImageAsset.mockResolvedValue(asset)

    const awareness = new FakeAwareness(1)
    const setSpy = vi.spyOn(awareness, "setLocalStateField")
    new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    awareness.remoteSetState(2, { [FIELD]: requestMessage({ assetId: assetId("6") }) })
    await vi.advanceTimersByTimeAsync(300) // past jitter, "start" sent once

    // Never ack: 3 retries at ACK_TIMEOUT_MS apart, then give up.
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4)

    const startAttempts = setSpy.mock.calls.filter(([, msg]: any[]) => msg?.kind === "start")
    expect(startAttempts.length).toBe(3)
  })
})

describe("acting as the requester receiving chunks", () => {
  it("acks the start message, stores the asset once all chunks arrive, and resolves requestAsset", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const receivedAsset = { id: assetId("7"), blob: new Blob(), mimeType: "image/png", size: 10, createdAt: 0 }
    storeReceivedImageAsset.mockResolvedValue(receivedAsset)

    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    const pending = transfer.requestAsset(assetId("7"))
    await flush()

    const bytes = pngBytes(10)
    const transferId = crypto.randomUUID()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "start", requestId: crypto.randomUUID(),
        transferId, from: 2, to: 1, assetId: assetId("7"), mimeType: "image/png",
        size: bytes.length, chunkCount: 1,
      },
    })
    await flush()

    // Requester should have acked the start (index -1).
    let ack = awareness.lastLocalMessage()
    expect(ack.kind).toBe("ack")
    expect(ack.index).toBe(-1)
    expect(ack.to).toBe(2)

    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "chunk",
        transferId, from: 2, to: 1, assetId: assetId("7"), index: 0, data: toBase64(bytes),
      },
    })
    await flush()

    ack = awareness.lastLocalMessage()
    expect(ack.kind).toBe("ack")
    expect(ack.index).toBe(0)

    expect(storeReceivedImageAsset).toHaveBeenCalledTimes(1)
    const [storedId, storedBlob] = storeReceivedImageAsset.mock.calls[0]
    expect(storedId).toBe(assetId("7"))
    expect(storedBlob.type).toBe("image/png")

    expect(await pending).toBe(receivedAsset)
  })

  it("reassembles a multi-chunk asset in order", async () => {
    getImageAsset.mockResolvedValue(undefined)
    storeReceivedImageAsset.mockResolvedValue({ id: assetId("8"), blob: new Blob(), mimeType: "image/png", size: 0, createdAt: 0 })

    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)
    void transfer.requestAsset(assetId("8"))
    await flush()

    const bytes = pngBytes(CHUNK_SIZE + 10)
    const transferId = crypto.randomUUID()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "start", requestId: crypto.randomUUID(),
        transferId, from: 2, to: 1, assetId: assetId("8"), mimeType: "image/png",
        size: bytes.length, chunkCount: 2,
      },
    })
    await flush()

    // Deliver chunk 1 before chunk 0 to check the transfer waits for both.
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "chunk", transferId, from: 2, to: 1,
        assetId: assetId("8"), index: 1, data: toBase64(bytes.subarray(CHUNK_SIZE)),
      },
    })
    await flush()
    expect(storeReceivedImageAsset).not.toHaveBeenCalled()

    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "chunk", transferId, from: 2, to: 1,
        assetId: assetId("8"), index: 0, data: toBase64(bytes.subarray(0, CHUNK_SIZE)),
      },
    })
    await flush()

    expect(storeReceivedImageAsset).toHaveBeenCalledTimes(1)
    const [, storedBlob] = storeReceivedImageAsset.mock.calls[0]
    expect(storedBlob.size).toBe(bytes.length)
  })

  it("never stores a chunk set whose bytes don't sniff as a recognized image format", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)
    void transfer.requestAsset(assetId("9"))
    await flush()

    const bytes = new Uint8Array(10).fill(0x41) // not any recognized magic-byte signature
    const transferId = crypto.randomUUID()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "start", requestId: crypto.randomUUID(),
        transferId, from: 2, to: 1, assetId: assetId("9"), mimeType: "image/png",
        size: bytes.length, chunkCount: 1,
      },
    })
    await flush()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "chunk", transferId, from: 2, to: 1,
        assetId: assetId("9"), index: 0, data: toBase64(bytes),
      },
    })
    await flush()

    expect(storeReceivedImageAsset).not.toHaveBeenCalled()
  })

  it("discards a chunk whose decoded length doesn't match the expected size", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)
    void transfer.requestAsset(assetId("10"))
    await flush()

    const transferId = crypto.randomUUID()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "start", requestId: crypto.randomUUID(),
        transferId, from: 2, to: 1, assetId: assetId("10"), mimeType: "image/png",
        size: 10, chunkCount: 1,
      },
    })
    await flush()
    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "chunk", transferId, from: 2, to: 1,
        assetId: assetId("10"), index: 0, data: toBase64(new Uint8Array(3)), // wrong length
      },
    })
    await flush()

    expect(storeReceivedImageAsset).not.toHaveBeenCalled()
  })
})

describe("destroy", () => {
  it("clears the local awareness field and resolves pending requests with undefined", async () => {
    getImageAsset.mockResolvedValue(undefined)
    const awareness = new FakeAwareness(1)
    const setSpy = vi.spyOn(awareness, "setLocalStateField")
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)

    const pending = transfer.requestAsset(assetId("11"))
    await flush()

    transfer.destroy()

    expect(await pending).toBeUndefined()
    expect(setSpy).toHaveBeenCalledWith(FIELD, null)
  })

  it("stops reacting to further awareness updates after being destroyed", async () => {
    hasImageAsset.mockResolvedValue(true)
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)
    transfer.destroy()

    awareness.remoteSetState(2, {
      [FIELD]: {
        version: 1, nonce: crypto.randomUUID(), kind: "request", requestId: crypto.randomUUID(),
        from: 2, assetId: assetId("12"), expiresAt: Date.now() + 120_000,
      },
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(hasImageAsset).not.toHaveBeenCalled()
  })

  it("is safe to call twice", () => {
    const awareness = new FakeAwareness(1)
    const transfer = new P2PImageAssetTransfer(awareness as unknown as Awareness, () => true)
    expect(() => {
      transfer.destroy()
      transfer.destroy()
    }).not.toThrow()
  })
})
