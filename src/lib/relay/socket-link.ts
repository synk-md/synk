/**
 * A `Link` over a WebSocket, on either side of it.
 *
 * Duck-typed rather than importing a socket library, for two reasons. The
 * server runs on Node with `ws` and the browser has its own `WebSocket`, and
 * neither belongs in a module the other imports. And a link that only needs
 * `send`, `close` and a pair of listeners can be driven by a fake in a test,
 * which is how the relay is exercised without opening a port.
 */

import type { Link, LinkState } from "./link"

/**
 * The part of a WebSocket this needs.
 *
 * The listener registrations are `unknown` rather than typed signatures on
 * purpose. `ws` and the browser both declare theirs with a generic keyed to
 * their own event maps, and any concrete signature written here is assignable
 * from neither. They are narrowed once, below, where the shape is actually
 * known.
 */
export interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener?: unknown
  on?: unknown
  readyState?: number
}

/** Node's emitter API, as `ws` exposes it. */
type NodeEmitter = (event: string, handler: (...args: unknown[]) => void) => void

/** The DOM's, as a browser `WebSocket` exposes it. */
type EventSubscriber = (type: string, handler: (event: unknown) => void) => void

const OPEN = 1

function textOf(payload: unknown): string | null {
  if (typeof payload === "string") return payload
  // `ws` delivers Buffers unless told otherwise. Checked with `ArrayBuffer.isView`
  // rather than `instanceof Uint8Array`, which fails across realms - exactly
  // what happens between Node's Buffer and a bundled module.
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(payload)
  }
  if (payload instanceof ArrayBuffer) return new TextDecoder().decode(payload)
  if (payload && typeof payload === "object" && "data" in payload) {
    return textOf((payload as { data: unknown }).data)
  }
  return null
}

/**
 * Wrap a connected socket.
 *
 * Assumes the socket is already open, which is what a server has when a
 * connection arrives. A client that needs to dial and redial wants
 * `WebSocketLink`, which owns that lifecycle.
 */
export class SocketLink implements Link {
  state: LinkState = "open"

  private readonly socket: SocketLike
  private readonly frames = new Set<(frame: string) => void>()
  private readonly states = new Set<(state: LinkState) => void>()

  constructor(socket: SocketLike) {
    this.socket = socket

    const onMessage = (payload: unknown) => {
      const frame = textOf(payload)
      if (frame === null) return
      for (const handler of this.frames) handler(frame)
    }
    const onClose = () => {
      this.setState("closed")
    }

    if (typeof socket.on === "function") {
      // Bound, not extracted: `ws` reads `this` inside `on`, and a bare
      // reference throws on the first registration.
      const on = (socket.on as NodeEmitter).bind(socket)
      on("message", (data: unknown) => onMessage(data))
      on("close", () => onClose())
      on("error", () => onClose())
    } else if (typeof socket.addEventListener === "function") {
      const listen = (socket.addEventListener as EventSubscriber).bind(socket)
      listen("message", onMessage)
      listen("close", onClose)
      listen("error", onClose)
    }
  }

  private setState(state: LinkState): void {
    if (this.state === state) return
    this.state = state
    for (const handler of this.states) handler(state)
  }

  send(frame: string): void {
    // A closed socket throws on send in `ws`, and a relay dropping one client's
    // frame must not take down the loop fanning out to the others.
    if (this.state !== "open") return
    if (this.socket.readyState !== undefined && this.socket.readyState !== OPEN) return
    try {
      this.socket.send(frame)
    } catch {
      this.setState("closed")
    }
  }

  onFrame(handler: (frame: string) => void): () => void {
    this.frames.add(handler)
    return () => this.frames.delete(handler)
  }

  onStateChange(handler: (state: LinkState) => void): () => void {
    this.states.add(handler)
    return () => this.states.delete(handler)
  }

  close(): void {
    this.setState("closed")
    this.frames.clear()
    try {
      this.socket.close()
    } catch {
      // Already gone.
    }
  }
}
