/**
 * The client side of the relay: a `Transport`, plus the hosting and archive
 * calls outside the envelope path. Same interface a peer link would implement,
 * which is what makes degradation a configuration change rather than a branch.
 *
 * Every response is untrusted input; the sync engine verifies each envelope
 * before it reaches the document.
 */

import type { SigningKey } from "@/lib/crypto"
import type { Snapshot } from "@/lib/snapshots"
import type { DeliveryVector, Envelope, Transport } from "@/lib/sync"

import { signChallenge } from "./auth"
import type { Link, LinkState } from "./link"
import {
  decode,
  encode,
  isPush,
  nextRequestId,
  RELAY_PROTOCOL_VERSION,
  type ClientMessage,
  type HostedRecord,
  type HostedSummary,
  type ServerMessage,
  type ServerPush,
  type ServerReply,
  type SliceRequest,
  type TurnCredentials,
} from "./protocol"

export type RelayConnection = "offline" | "connecting" | "authenticating" | "online"

export interface RelayClientOptions {
  link: Link
  relayId: string
  did: string
  signingKey: SigningKey
  resourceId: string
  /** How long to wait for a reply before giving up on that request. */
  timeoutMs?: number
  onConnectionChange?: (state: RelayConnection) => void
  onFreshness?: (summary: HostedSummary) => void
  onSignal?: (from: string, payload: string) => void
  onError?: (error: unknown) => void
}

interface Pending {
  resolve: (reply: ServerReply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RelayClient implements Transport {
  readonly name = "relay"

  private readonly options: RelayClientOptions
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Set<(envelope: Envelope) => void>()
  private readonly offFrame: () => void
  private readonly offState: () => void
  private connection: RelayConnection = "offline"
  private handshake: Promise<void> | undefined
  private closed = false

  constructor(options: RelayClientOptions) {
    this.options = options

    this.offFrame = options.link.onFrame((frame) => {
      this.onFrame(frame)
    })
    this.offState = options.link.onStateChange((state) => {
      this.onLinkState(state)
    })
    if (options.link.state === "open") void this.ensureReady()
    else this.setConnection(options.link.state === "connecting" ? "connecting" : "offline")
  }

  get state(): RelayConnection {
    return this.connection
  }

  private setConnection(next: RelayConnection): void {
    if (this.connection === next) return
    this.connection = next
    this.options.onConnectionChange?.(next)
  }

  private onLinkState(state: LinkState): void {
    if (state === "open") {
      // A new socket means a new challenge.
      this.handshake = undefined
      void this.ensureReady()
      return
    }
    this.setConnection(state === "connecting" ? "connecting" : "offline")
    // Fail what is in flight, so callers fall back instead of hanging.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("relay link closed"))
    }
    this.pending.clear()
  }

  private onFrame(frame: string): void {
    const message = decode<ServerMessage>(frame)
    if (!message) return

    if (isPush(message)) return this.onPush(message)

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  private onPush(push: ServerPush): void {
    switch (push.push) {
      case "envelope":
        for (const handler of this.handlers) handler(push.envelope)
        return
      case "freshness":
        this.options.onFreshness?.(push.summary)
        return
      case "signal":
        this.options.onSignal?.(push.from, push.payload)
        return
    }
  }

  private request(message: Omit<ClientMessage, "id"> & { id?: string }): Promise<ServerReply> {
    const id = message.id ?? nextRequestId()
    const framed = { ...message, id } as ClientMessage

    return new Promise<ServerReply>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("relay client closed"))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`relay request ${framed.op} timed out`))
      }, this.options.timeoutMs ?? 10_000)

      this.pending.set(id, { resolve, reject, timer })
      this.options.link.send(encode(framed))
    })
  }

  /** Once per link. Awaited by every call, so nothing races the handshake. */
  private ensureReady(): Promise<void> {
    this.handshake ??= this.doHandshake().catch((error: unknown) => {
      this.handshake = undefined
      this.setConnection("offline")
      throw error
    })
    return this.handshake
  }

  private async doHandshake(): Promise<void> {
    this.setConnection("connecting")
    const hello = await this.request({ op: "hello", v: RELAY_PROTOCOL_VERSION })
    if (!hello.ok || hello.re !== "hello") throw new Error("relay refused the handshake")

    this.setConnection("authenticating")
    const sig = await signChallenge(this.options.signingKey, this.options.relayId, hello.challenge)
    const auth = await this.request({ op: "auth", did: this.options.did, sig })
    if (!auth.ok) throw new Error(`relay refused authentication: ${auth.error}`)

    await this.request({ op: "subscribe", resources: [this.options.resourceId] })
    this.setConnection("online")
  }

  private async call(message: Omit<ClientMessage, "id">): Promise<ServerReply | undefined> {
    try {
      await this.ensureReady()
      const reply = await this.request(message)
      return reply.ok ? reply : undefined
    } catch (error) {
      // A relay that is down is a delay, not an error to propagate upward.
      this.options.onError?.(error)
      return undefined
    }
  }

  /* ---- Transport --------------------------------------------------------- */

  async publish(envelope: Envelope): Promise<void> {
    await this.call({ op: "publish", envelope })
  }

  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async fetchSince(vector: DeliveryVector): Promise<Envelope[]> {
    const reply = await this.call({ op: "since", resourceId: this.options.resourceId, vector })
    return reply?.ok && reply.re === "since" ? reply.envelopes : []
  }

  async vector(): Promise<DeliveryVector> {
    const reply = await this.call({ op: "vector", resourceId: this.options.resourceId })
    // Empty on failure, so the client pushes its backlog rather than
    // concluding the relay already has it.
    return reply?.ok && reply.re === "vector" ? reply.vector : {}
  }

  async depositSnapshot(snapshot: Snapshot): Promise<void> {
    await this.call({ op: "deposit-snapshot", snapshot })
  }

  async fetchSnapshots(resourceId: string): Promise<Snapshot[]> {
    const reply = await this.call({ op: "snapshots", resourceId })
    return reply?.ok && reply.re === "snapshots" ? reply.snapshots : []
  }

  /* ---- archive, hosting, signaling --------------------------------------- */

  /** A bounded window of history, for filling a known gap. */
  async fetchSlice(request: SliceRequest): Promise<{ envelopes: Envelope[]; complete: boolean }> {
    const reply = await this.call({ op: "slice", request })
    return reply?.ok && reply.re === "slice"
      ? { envelopes: reply.envelopes, complete: reply.complete }
      : { envelopes: [], complete: false }
  }

  async getRecords(workspace: string, kind?: HostedRecord["kind"]): Promise<HostedRecord[]> {
    const reply = await this.call(
      kind === undefined ? { op: "records-get", workspace } : { op: "records-get", workspace, kind },
    )
    return reply?.ok && reply.re === "records-get" ? reply.records : []
  }

  async putRecords(records: readonly HostedRecord[]): Promise<number> {
    const reply = await this.call({ op: "records-put", records: [...records] })
    return reply?.ok && reply.re === "records-put" ? reply.stored : 0
  }

  async fetchFreshness(workspace: string): Promise<HostedSummary | null> {
    const reply = await this.call({ op: "freshness", workspace })
    return reply?.ok && reply.re === "freshness" ? reply.summary : null
  }

  async sendSignal(to: string, payload: string): Promise<boolean> {
    const reply = await this.call({ op: "signal", to, payload })
    return reply?.ok === true
  }

  async turnCredentials(): Promise<TurnCredentials | undefined> {
    const reply = await this.call({ op: "turn" })
    return reply?.ok && reply.re === "turn" ? reply.credentials : undefined
  }

  close(): void {
    this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("relay client closed"))
    }
    this.pending.clear()
    this.handlers.clear()
    this.offFrame()
    this.offState()
    this.setConnection("offline")
  }
}
