/**
 * The byte pipe under the protocol, separated so the real server can be driven
 * through the real protocol in tests with only the wire faked.
 */

export type LinkState = "closed" | "connecting" | "open"

export interface Link {
  readonly state: LinkState
  send(frame: string): void
  onFrame(handler: (frame: string) => void): () => void
  onStateChange(handler: (state: LinkState) => void): () => void
  close(): void
}

/** Both ends of an in-process pair, for tests and for a same-tab relay. */
export class LoopbackLink implements Link {
  state: LinkState = "open"
  /** Set false to model the wire being down without either end closing. */
  delivering = true

  private peer: LoopbackLink | undefined
  private readonly frames = new Set<(frame: string) => void>()
  private readonly states = new Set<(state: LinkState) => void>()
  /** Frames sent while not delivering, replayed on reconnect. */
  private readonly queued: string[] = []

  static pair(): [LoopbackLink, LoopbackLink] {
    const a = new LoopbackLink()
    const b = new LoopbackLink()
    a.peer = b
    b.peer = a
    return [a, b]
  }

  send(frame: string): void {
    if (this.state !== "open") return
    if (!this.delivering) {
      this.queued.push(frame)
      return
    }
    this.peer?.receive(frame)
  }

  receive(frame: string): void {
    for (const handler of this.frames) handler(frame)
  }

  onFrame(handler: (frame: string) => void): () => void {
    this.frames.add(handler)
    return () => this.frames.delete(handler)
  }

  onStateChange(handler: (state: LinkState) => void): () => void {
    this.states.add(handler)
    return () => this.states.delete(handler)
  }

  setState(state: LinkState): void {
    this.state = state
    for (const handler of this.states) handler(state)
  }

  /** Bring the wire back and flush what was written while it was down. */
  resume(): void {
    this.delivering = true
    const pending = this.queued.splice(0, this.queued.length)
    for (const frame of pending) this.peer?.receive(frame)
  }

  close(): void {
    this.setState("closed")
    this.frames.clear()
  }
}

export interface WebSocketLinkOptions {
  url: string
  /** Injected so this is testable and so a worker can supply its own. */
  factory?: (url: string) => WebSocket
  /** Backoff ceiling. Reconnection is what makes an outage a delay. */
  maxBackoffMs?: number
  /** Deterministic backoff in tests. */
  now?: () => number
}

/**
 * A reconnecting WebSocket. Everything above assumes an outage is a delay, and
 * that is only true if something reconnects. Jittered so a restarted relay is
 * not met by every client it dropped at once.
 */
export class WebSocketLink implements Link {
  state: LinkState = "closed"

  private socket: WebSocket | undefined
  private readonly frames = new Set<(frame: string) => void>()
  private readonly states = new Set<(state: LinkState) => void>()
  private readonly options: Required<Omit<WebSocketLinkOptions, "factory">> & {
    factory: (url: string) => WebSocket
  }
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Written while disconnected, sent on reconnect rather than dropped. */
  private readonly queued: string[] = []

  constructor(options: WebSocketLinkOptions) {
    this.options = {
      url: options.url,
      factory: options.factory ?? ((url: string) => new WebSocket(url)),
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      now: options.now ?? (() => Date.now()),
    }
    this.connect()
  }

  private setState(state: LinkState): void {
    if (this.state === state) return
    this.state = state
    for (const handler of this.states) handler(state)
  }

  private connect(): void {
    if (this.disposed) return
    this.setState("connecting")

    let socket: WebSocket
    try {
      socket = this.options.factory(this.options.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.setState("open")
      const pending = this.queued.splice(0, this.queued.length)
      for (const frame of pending) socket.send(frame)
    }
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        for (const handler of this.frames) handler(event.data)
      }
    }
    socket.onclose = () => {
      this.socket = undefined
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // `onclose` always follows; the reconnect is scheduled there.
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      this.setState("closed")
      return
    }
    this.setState("connecting")
    this.attempt += 1
    const base = Math.min(this.options.maxBackoffMs, 500 * 2 ** (this.attempt - 1))
    const delay = base / 2 + Math.random() * (base / 2)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  send(frame: string): void {
    if (this.socket && this.state === "open") this.socket.send(frame)
    else this.queued.push(frame)
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
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close()
    this.socket = undefined
    this.setState("closed")
    this.frames.clear()
  }
}
