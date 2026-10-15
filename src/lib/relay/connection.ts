/**
 * One socket, many resources.
 *
 * A notebook syncs several notes at once - the open one, plus whatever peers
 * are looking at - and a connection per note would mean a handshake and a
 * socket each. So the link, the handshake and the request plumbing live here,
 * and `transportFor` hands out a `Transport` per resource over the same wire.
 *
 * Pushes are routed by the resource the envelope names, so a note only ever
 * sees its own.
 */

import type { SigningKey } from "@/lib/crypto"
import type { Snapshot } from "@/lib/snapshots"
import type { DeliveryVector, Envelope, Transport } from "@/lib/sync"
import type { WorkspaceGenesis } from "@/lib/workspace/genesis"

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

export type RelayConnectionState = "offline" | "connecting" | "authenticating" | "online"

export interface RelayConnectionOptions {
  link: Link
  relayId: string
  did: string
  signingKey: SigningKey
  timeoutMs?: number
  onConnectionChange?: (state: RelayConnectionState) => void
  onFreshness?: (summary: HostedSummary) => void
  onSignal?: (from: string, payload: string) => void
  onError?: (error: unknown) => void
}

interface Pending {
  resolve: (reply: ServerReply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** A request without its id. Distributive: `Omit` over a union keeps only `op`. */
type ClientRequest = ClientMessage extends infer T
  ? T extends { id: string }
    ? Omit<T, "id">
    : never
  : never

export class RelayConnection {
  private readonly options: RelayConnectionOptions
  private readonly pending = new Map<string, Pending>()
  /** Envelope handlers per resource, so a note only sees its own. */
  private readonly handlers = new Map<string, Set<(envelope: Envelope) => void>>()
  private readonly transports = new Map<string, Transport>()
  private readonly subscribed = new Set<string>()
  private readonly offFrame: () => void
  private readonly offState: () => void
  private connection: RelayConnectionState = "offline"
  private handshake: Promise<void> | undefined
  private closed = false

  constructor(options: RelayConnectionOptions) {
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

  get state(): RelayConnectionState {
    return this.connection
  }

  private setConnection(next: RelayConnectionState): void {
    if (this.connection === next) return
    this.connection = next
    this.options.onConnectionChange?.(next)
  }

  private onLinkState(state: LinkState): void {
    if (state === "open") {
      // A new socket means a new challenge, and the server has forgotten what
      // this connection was subscribed to.
      this.handshake = undefined
      this.subscribed.clear()
      void this.ensureReady()
      return
    }
    this.setConnection(state === "connecting" ? "connecting" : "offline")
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
        for (const handler of this.handlers.get(push.envelope.resourceId) ?? []) {
          handler(push.envelope)
        }
        return
      case "freshness":
        this.options.onFreshness?.(push.summary)
        return
      case "signal":
        this.options.onSignal?.(push.from, push.payload)
        return
    }
  }

  private request(message: ClientRequest): Promise<ServerReply> {
    const id = nextRequestId()
    const framed = { ...message, id } as ClientMessage

    return new Promise<ServerReply>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("relay connection closed"))
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

  private ensureReady(): Promise<void> {
    if (!this.handshake) {
      const attempt = this.doHandshake().catch((error: unknown) => {
        this.handshake = undefined
        this.setConnection("offline")
        throw error
      })
      // Callers awaiting it still see the rejection. This keeps the *stored*
      // reference handled, so closing the connection mid-handshake does not
      // surface as an unhandled rejection with nobody left to receive it.
      attempt.catch(() => undefined)
      this.handshake = attempt
    }
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
    this.setConnection("online")

    // Re-subscribe to everything a transport asked for. After a reconnect the
    // server remembers nothing, and a resource left unsubscribed receives no
    // pushes at all - which looks exactly like nobody editing.
    const wanted = [...this.handlers.keys(), ...this.transports.keys()]
    if (wanted.length > 0) await this.subscribe(wanted)
  }

  private async subscribe(resources: readonly string[]): Promise<void> {
    const missing = resources.filter((resource) => !this.subscribed.has(resource))
    if (missing.length === 0) return
    const reply = await this.request({ op: "subscribe", resources: [...missing] })
    if (reply.ok) for (const resource of missing) this.subscribed.add(resource)
  }

  /** A relay that is down is a delay, not an error to propagate upward. */
  private async call(message: ClientRequest): Promise<ServerReply | undefined> {
    try {
      await this.ensureReady()
      const reply = await this.request(message)
      return reply.ok ? reply : undefined
    } catch (error) {
      this.options.onError?.(error)
      return undefined
    }
  }

  /** The transport for one resource. Cached, so a note has exactly one. */
  transportFor(resourceId: string): Transport {
    const existing = this.transports.get(resourceId)
    if (existing) return existing

    // Arrow properties so `this` is the connection, with no alias.
    const transport: Transport = {
      name: `relay:${resourceId}`,

      publish: async (envelope: Envelope): Promise<void> => {
        await this.call({ op: "publish", envelope })
      },

      subscribe: (handler: (envelope: Envelope) => void): (() => void) => {
        const set = this.handlers.get(resourceId) ?? new Set()
        set.add(handler)
        this.handlers.set(resourceId, set)
        // Subscribing is what makes the relay push to this connection at all.
        void this.call({ op: "subscribe", resources: [resourceId] }).then(() => {
          this.subscribed.add(resourceId)
        })
        return () => set.delete(handler)
      },

      fetchSince: async (vector: DeliveryVector): Promise<Envelope[]> => {
        const reply = await this.call({ op: "since", resourceId, vector })
        return reply?.ok && reply.re === "since" ? reply.envelopes : []
      },

      vector: async (): Promise<DeliveryVector> => {
        const reply = await this.call({ op: "vector", resourceId })
        // Empty on failure, so the caller pushes its backlog rather than
        // concluding the relay already has it.
        return reply?.ok && reply.re === "vector" ? reply.vector : {}
      },

      floor: async (): Promise<DeliveryVector> => {
        const reply = await this.call({ op: "floor", resourceId })
        return reply?.ok && reply.re === "floor" ? reply.floor : {}
      },

      depositSnapshot: async (snapshot: Snapshot): Promise<void> => {
        await this.call({ op: "deposit-snapshot", snapshot })
      },

      fetchSnapshots: async (resource: string): Promise<Snapshot[]> => {
        const reply = await this.call({ op: "snapshots", resourceId: resource })
        return reply?.ok && reply.re === "snapshots" ? reply.snapshots : []
      },

      close: (): void => {
        this.handlers.delete(resourceId)
        this.transports.delete(resourceId)
      },
    }

    this.transports.set(resourceId, transport)
    return transport
  }

  /* ---- not per resource -------------------------------------------------- */

  async fetchSlice(request: SliceRequest): Promise<{ envelopes: Envelope[]; complete: boolean }> {
    const reply = await this.call({ op: "slice", request })
    return reply?.ok && reply.re === "slice"
      ? { envelopes: reply.envelopes, complete: reply.complete }
      : { envelopes: [], complete: false }
  }

  /** As the owner, so the relay may let envelopes go behind this device's anchors. */
  async claimOwnership(genesis: WorkspaceGenesis): Promise<boolean> {
    const reply = await this.call({ op: "claim-owner", genesis })
    return reply?.ok === true
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
      pending.reject(new Error("relay connection closed"))
    }
    this.pending.clear()
    this.handlers.clear()
    this.transports.clear()
    this.subscribed.clear()
    this.offFrame()
    this.offState()
    this.setConnection("offline")
  }
}
