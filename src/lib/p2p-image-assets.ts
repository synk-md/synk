import type { Awareness } from "y-protocols/awareness"

import {
  getImageAsset,
  hasImageAsset,
  storeReceivedImageAsset,
  type StoredImageAsset,
} from "@/lib/image-assets"

const AWARENESS_FIELD = "synkImageAssetTransfer"
const PROTOCOL_VERSION = 1
const CHUNK_SIZE = 12 * 1024
const ACK_TIMEOUT_MS = 4_000
const ACK_RETRIES = 3
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ASSET_SIZE = 5 * 1024 * 1024
const MAX_ENCODED_CHUNK_SIZE = Math.ceil(CHUNK_SIZE / 3) * 4 + 4
const ASSET_ID_PATTERN = /^sha256:[0-9a-f]{64}$/

// Awareness is already encrypted and transported by the note's Y-WebRTC room.
// Only one small, transient message lives here at a time; image bytes never
// become part of the persisted Yjs document.

type AssetRequestMessage = {
  version: 1
  nonce: string
  kind: "request"
  requestId: string
  from: number
  assetId: string
  expiresAt: number
}

type AssetStartMessage = {
  version: 1
  nonce: string
  kind: "start"
  requestId: string
  transferId: string
  from: number
  to: number
  assetId: string
  mimeType: string
  size: number
  chunkCount: number
}

type AssetChunkMessage = {
  version: 1
  nonce: string
  kind: "chunk"
  transferId: string
  from: number
  to: number
  assetId: string
  index: number
  data: string
}

type AssetAckMessage = {
  version: 1
  nonce: string
  kind: "ack"
  transferId: string
  from: number
  to: number
  index: number
}

type AssetTransferMessage =
  | AssetRequestMessage
  | AssetStartMessage
  | AssetChunkMessage
  | AssetAckMessage

type PendingRequest = {
  resolves: Array<(asset: StoredImageAsset | undefined) => void>
  timer: ReturnType<typeof setTimeout>
  transferId?: string
}

type IncomingTransfer = {
  requestId: string
  transferId: string
  from: number
  assetId: string
  mimeType: string
  size: number
  chunkCount: number
  chunks: Array<Uint8Array | undefined>
  receivedChunks: number
}

type AckWaiter = {
  from: number
  resolve: () => void
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

// The sender's `mimeType` field is an unverified claim - re-derive the real
// type from the bytes instead of trusting it, so a peer can't mislabel
// arbitrary content as an image.
const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (bytes: Uint8Array) => boolean }> = [
  {
    mimeType: "image/png",
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a,
  },
  {
    mimeType: "image/jpeg",
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mimeType: "image/gif",
    matches: (bytes) =>
      bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61,
  },
  {
    mimeType: "image/webp",
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50,
  },
  {
    mimeType: "image/bmp",
    matches: (bytes) => bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d,
  },
  {
    mimeType: "image/svg+xml",
    matches: (bytes) => {
      const head = new TextDecoder("ascii", { fatal: false })
        .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
        .toLowerCase()
      return head.includes("<svg")
    },
  },
]

function sniffImageMimeType(bytes: Uint8Array): string | null {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(bytes))?.mimeType ?? null
}

function isTransferMessage(value: unknown): value is AssetTransferMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Record<string, unknown>
  if (
    message.version !== PROTOCOL_VERSION ||
    typeof message.nonce !== "string" ||
    message.nonce.length > 100 ||
    typeof message.kind !== "string" ||
    typeof message.from !== "number" ||
    !Number.isSafeInteger(message.from)
  ) {
    return false
  }

  switch (message.kind) {
    case "request":
      return (
        typeof message.requestId === "string" &&
        message.requestId.length <= 100 &&
        typeof message.assetId === "string" &&
        ASSET_ID_PATTERN.test(message.assetId) &&
        typeof message.expiresAt === "number" &&
        Number.isSafeInteger(message.expiresAt)
      )
    case "start":
      return (
        typeof message.requestId === "string" &&
        message.requestId.length <= 100 &&
        typeof message.transferId === "string" &&
        message.transferId.length <= 100 &&
        typeof message.to === "number" &&
        Number.isSafeInteger(message.to) &&
        typeof message.assetId === "string" &&
        ASSET_ID_PATTERN.test(message.assetId) &&
        typeof message.mimeType === "string" &&
        message.mimeType.length <= 255 &&
        typeof message.size === "number" &&
        Number.isSafeInteger(message.size) &&
        typeof message.chunkCount === "number" &&
        Number.isSafeInteger(message.chunkCount)
      )
    case "chunk":
      return (
        typeof message.transferId === "string" &&
        message.transferId.length <= 100 &&
        typeof message.to === "number" &&
        Number.isSafeInteger(message.to) &&
        typeof message.assetId === "string" &&
        ASSET_ID_PATTERN.test(message.assetId) &&
        typeof message.index === "number" &&
        Number.isSafeInteger(message.index) &&
        typeof message.data === "string" &&
        message.data.length <= MAX_ENCODED_CHUNK_SIZE
      )
    case "ack":
      return (
        typeof message.transferId === "string" &&
        message.transferId.length <= 100 &&
        typeof message.to === "number" &&
        Number.isSafeInteger(message.to) &&
        typeof message.index === "number" &&
        Number.isSafeInteger(message.index)
      )
    default:
      return false
  }
}

export class P2PImageAssetTransfer {
  private readonly awareness: Awareness
  private readonly clientId: number
  private readonly isAssetReferenced: (assetId: string) => boolean
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly incomingTransfers = new Map<string, IncomingTransfer>()
  private readonly ackWaiters = new Map<string, AckWaiter>()
  private readonly handledRequests = new Set<string>()
  private readonly completedTransfers = new Set<string>()
  private destroyed = false

  /**
   * @param isAssetReferenced Called with an assetId a peer is requesting.
   * Must return whether that asset is actually embedded in the note this
   * transfer instance is scoped to - peers can only pull images that are
   * part of the note they're collaborating on, not anything else this
   * client happens to have cached locally.
   */
  constructor(awareness: Awareness, isAssetReferenced: (assetId: string) => boolean) {
    this.awareness = awareness
    this.clientId = awareness.clientID
    this.isAssetReferenced = isAssetReferenced
    awareness.on("update", this.handleAwarenessUpdate)
  }

  async requestAsset(assetId: string): Promise<StoredImageAsset | undefined> {
    const localAsset = await getImageAsset(assetId)
    if (localAsset || this.destroyed) return localAsset

    const existing = this.pendingRequests.get(assetId)
    if (existing) {
      return await new Promise((resolve) => existing.resolves.push(resolve))
    }

    return await new Promise<StoredImageAsset | undefined>((resolve) => {
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => this.expirePendingRequest(assetId), REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(assetId, { resolves: [resolve], timer })
      this.send({
        version: PROTOCOL_VERSION,
        nonce: crypto.randomUUID(),
        kind: "request",
        requestId,
        from: this.clientId,
        assetId,
        expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
      })
    })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.awareness.off("update", this.handleAwarenessUpdate)

    this.pendingRequests.forEach(({ resolves, timer }) => {
      clearTimeout(timer)
      resolves.forEach((resolve) => resolve(undefined))
    })
    this.pendingRequests.clear()
    this.incomingTransfers.clear()
    this.ackWaiters.clear()
    this.handledRequests.clear()
    this.completedTransfers.clear()

    const current = this.awareness.getLocalState()?.[AWARENESS_FIELD]
    if (current) {
      this.awareness.setLocalStateField(AWARENESS_FIELD, null)
    }
  }

  private readonly handleAwarenessUpdate = ({
    added,
    updated,
  }: {
    added: number[]
    updated: number[]
    removed: number[]
  }) => {
    if (this.destroyed) return

    for (const clientId of [...added, ...updated]) {
      if (clientId === this.clientId) continue
      const message = this.awareness.getStates().get(clientId)?.[AWARENESS_FIELD]
      if (!isTransferMessage(message)) continue
      void this.handleMessage(message, clientId)
    }
  }

  private async handleMessage(message: AssetTransferMessage, senderClientId: number) {
    if (message.from !== senderClientId) return

    switch (message.kind) {
      case "request":
        await this.handleRequest(message)
        break
      case "start":
        await this.handleStart(message)
        break
      case "chunk":
        await this.handleChunk(message)
        break
      case "ack":
        this.handleAck(message)
        break
    }
  }

  private async handleRequest(message: AssetRequestMessage) {
    if (
      message.from === this.clientId ||
      message.expiresAt < Date.now() ||
      this.handledRequests.has(message.requestId) ||
      !this.isAssetReferenced(message.assetId)
    ) {
      return
    }

    this.handledRequests.add(message.requestId)
    setTimeout(() => this.handledRequests.delete(message.requestId), REQUEST_TIMEOUT_MS)
    if (!(await hasImageAsset(message.assetId))) return

    // Give another holder a small chance to answer first and reduce duplicate sends.
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200))
    if (!this.destroyed) {
      void this.serveAsset(message)
    }
  }

  private async serveAsset(request: AssetRequestMessage) {
    const asset = await getImageAsset(request.assetId)
    if (!asset || asset.size > MAX_ASSET_SIZE || this.destroyed) return

    const transferId = crypto.randomUUID()
    const bytes = new Uint8Array(await asset.blob.arrayBuffer())
    const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE))

    const started = await this.sendWithAck(
      {
        version: PROTOCOL_VERSION,
        nonce: crypto.randomUUID(),
        kind: "start",
        requestId: request.requestId,
        transferId,
        from: this.clientId,
        to: request.from,
        assetId: asset.id,
        mimeType: asset.mimeType,
        size: asset.size,
        chunkCount,
      },
      -1,
    )
    if (!started) return

    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
      const acknowledged = await this.sendWithAck(
        {
          version: PROTOCOL_VERSION,
          nonce: crypto.randomUUID(),
          kind: "chunk",
          transferId,
          from: this.clientId,
          to: request.from,
          assetId: asset.id,
          index,
          data: arrayBufferToBase64(chunk),
        },
        index,
      )
      if (!acknowledged || this.destroyed) return
    }
  }

  private async handleStart(message: AssetStartMessage) {
    if (
      message.to !== this.clientId ||
      message.size < 0 ||
      message.size > MAX_ASSET_SIZE ||
      message.chunkCount !== Math.max(1, Math.ceil(message.size / CHUNK_SIZE))
    ) {
      return
    }

    const pending = this.pendingRequests.get(message.assetId)
    if (!pending) return
    if (pending.transferId && pending.transferId !== message.transferId) return

    pending.transferId = message.transferId
    this.refreshPendingRequestTimeout(message.assetId)
    if (!this.incomingTransfers.has(message.transferId)) {
      this.incomingTransfers.set(message.transferId, {
        requestId: message.requestId,
        transferId: message.transferId,
        from: message.from,
        assetId: message.assetId,
        mimeType: message.mimeType,
        size: message.size,
        chunkCount: message.chunkCount,
        chunks: new Array(message.chunkCount),
        receivedChunks: 0,
      })
    }

    this.sendAck(message.transferId, message.from, -1)
  }

  private async handleChunk(message: AssetChunkMessage) {
    if (message.to !== this.clientId) return

    if (this.completedTransfers.has(message.transferId)) {
      this.sendAck(message.transferId, message.from, message.index)
      return
    }

    const transfer = this.incomingTransfers.get(message.transferId)
    if (
      !transfer ||
      transfer.from !== message.from ||
      transfer.assetId !== message.assetId ||
      message.index < 0 ||
      message.index >= transfer.chunkCount
    ) {
      return
    }

    try {
      if (!transfer.chunks[message.index]) {
        const chunk = base64ToBytes(message.data)
        const expectedLength =
          message.index === transfer.chunkCount - 1
            ? transfer.size - message.index * CHUNK_SIZE
            : CHUNK_SIZE
        if (chunk.byteLength !== expectedLength) return

        transfer.chunks[message.index] = chunk
        transfer.receivedChunks += 1
      }
    } catch {
      return
    }

    this.refreshPendingRequestTimeout(transfer.assetId)

    if (transfer.receivedChunks !== transfer.chunkCount) {
      this.sendAck(message.transferId, message.from, message.index)
      return
    }

    try {
      const chunks = transfer.chunks as Uint8Array[]
      const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      if (byteLength !== transfer.size) {
        throw new Error(`Image asset size check failed for ${transfer.assetId}`)
      }

      const sniffedMimeType = sniffImageMimeType(chunks[0] ?? new Uint8Array())
      if (!sniffedMimeType) {
        throw new Error(`Received asset ${transfer.assetId} is not a recognized image format`)
      }

      const blob = new Blob(chunks, { type: sniffedMimeType })
      const asset = await storeReceivedImageAsset(transfer.assetId, blob)
      this.completedTransfers.add(message.transferId)
      setTimeout(() => this.completedTransfers.delete(message.transferId), ACK_TIMEOUT_MS * 2)
      this.incomingTransfers.delete(message.transferId)
      this.sendAck(message.transferId, message.from, message.index)
      this.resolvePendingRequest(asset)
    } catch (error) {
      this.incomingTransfers.delete(message.transferId)
      console.error("P2P image transfer failed:", error)
    }
  }

  private handleAck(message: AssetAckMessage) {
    if (message.to !== this.clientId) return
    const waiter = this.ackWaiters.get(this.ackKey(message.transferId, message.index))
    if (waiter?.from === message.from) {
      waiter.resolve()
    }
  }

  private resolvePendingRequest(asset: StoredImageAsset) {
    const pending = this.pendingRequests.get(asset.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingRequests.delete(asset.id)
    pending.resolves.forEach((resolve) => resolve(asset))
  }

  private refreshPendingRequestTimeout(assetId: string) {
    const pending = this.pendingRequests.get(assetId)
    if (!pending) return

    clearTimeout(pending.timer)
    pending.timer = setTimeout(
      () => this.expirePendingRequest(assetId),
      REQUEST_TIMEOUT_MS,
    )
  }

  private expirePendingRequest(assetId: string) {
    const pending = this.pendingRequests.get(assetId)
    if (!pending) return

    this.pendingRequests.delete(assetId)
    if (pending.transferId) {
      this.incomingTransfers.delete(pending.transferId)
    }
    pending.resolves.forEach((resolve) => resolve(undefined))
  }

  private sendAck(transferId: string, to: number, index: number) {
    this.send({
      version: PROTOCOL_VERSION,
      nonce: crypto.randomUUID(),
      kind: "ack",
      transferId,
      from: this.clientId,
      to,
      index,
    })
  }

  private async sendWithAck(
    message: AssetStartMessage | AssetChunkMessage,
    index: number,
  ): Promise<boolean> {
    const key = this.ackKey(message.transferId, index)

    for (let attempt = 0; attempt < ACK_RETRIES && !this.destroyed; attempt += 1) {
      const acknowledged = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.ackWaiters.delete(key)
          resolve(false)
        }, ACK_TIMEOUT_MS)

        this.ackWaiters.set(key, {
          from: message.to,
          resolve: () => {
            clearTimeout(timer)
            this.ackWaiters.delete(key)
            resolve(true)
          },
        })
        this.send({ ...message, nonce: crypto.randomUUID() })
      })

      if (acknowledged) return true
    }

    return false
  }

  private send(message: AssetTransferMessage) {
    if (this.destroyed) return
    this.awareness.setLocalStateField(AWARENESS_FIELD, message)
  }

  private ackKey(transferId: string, index: number): string {
    return `${transferId}:${index}`
  }
}
