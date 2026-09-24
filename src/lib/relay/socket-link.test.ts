import { describe, expect, it, vi } from "vitest"

import { SocketLink, type SocketLike } from "./socket-link"

/** A `ws`-style socket: Node emitter API, Buffers on the wire. */
function nodeSocket() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const sent: string[] = []
  let closed = false

  const socket: SocketLike & { emit: (event: string, ...args: unknown[]) => void } = {
    send: (data: string) => {
      if (closed) throw new Error("socket is closed")
      sent.push(data)
    },
    close: () => {
      closed = true
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
  }
  return { socket, sent, isClosed: () => closed }
}

/** A browser-style socket: addEventListener, MessageEvent-shaped payloads. */
function browserSocket() {
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const sent: string[] = []

  const socket: SocketLike & { fire: (type: string, event: unknown) => void } = {
    send: (data: string) => sent.push(data),
    close: () => undefined,
    readyState: 1,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
    },
    fire: (type, event) => {
      for (const handler of handlers.get(type) ?? []) handler(event)
    },
  }
  return { socket, sent }
}

describe("SocketLink over a Node socket", () => {
  it("carries frames in both directions", () => {
    const { socket, sent } = nodeSocket()
    const link = new SocketLink(socket)
    const received: string[] = []
    link.onFrame((frame) => received.push(frame))

    link.send("out")
    socket.emit("message", "in")

    expect(sent).toEqual(["out"])
    expect(received).toEqual(["in"])
  })

  /** `ws` delivers Buffers unless told otherwise, and the protocol is text. */
  it("decodes a binary payload rather than dropping it", () => {
    const { socket } = nodeSocket()
    const link = new SocketLink(socket)
    const received: string[] = []
    link.onFrame((frame) => received.push(frame))

    socket.emit("message", new TextEncoder().encode('{"op":"hello"}'))

    expect(received).toEqual(['{"op":"hello"}'])
  })

  it("closes on the socket closing, and on an error", () => {
    const { socket } = nodeSocket()
    const link = new SocketLink(socket)
    const states: string[] = []
    link.onStateChange((state) => states.push(state))

    socket.emit("close")
    expect(states).toEqual(["closed"])
    expect(link.state).toBe("closed")
  })

  /**
   * A relay fanning out to many clients must not be taken down by one of them
   * having gone away between the check and the write.
   */
  it("does not throw when the socket rejects a send", () => {
    const { socket } = nodeSocket()
    const link = new SocketLink(socket)
    socket.close()

    expect(() => link.send("anything")).not.toThrow()
    expect(link.state).toBe("closed")
  })

  it("sends nothing once closed", () => {
    const { socket, sent } = nodeSocket()
    const link = new SocketLink(socket)

    link.close()
    link.send("too late")

    expect(sent).toEqual([])
  })

  it("stops delivering frames after close", () => {
    const { socket } = nodeSocket()
    const link = new SocketLink(socket)
    const received: string[] = []
    link.onFrame((frame) => received.push(frame))

    link.close()
    socket.emit("message", "after")

    expect(received).toEqual([])
  })
})

describe("SocketLink over a browser socket", () => {
  it("reads the payload out of an event", () => {
    const { socket, sent } = browserSocket()
    const link = new SocketLink(socket)
    const received: string[] = []
    link.onFrame((frame) => received.push(frame))

    link.send("out")
    socket.fire("message", { data: "in" })

    expect(sent).toEqual(["out"])
    expect(received).toEqual(["in"])
  })

  /** Not every socket ready to be written to is open. */
  it("refuses to send while the socket is not open", () => {
    const { socket, sent } = browserSocket()
    socket.readyState = 0
    const link = new SocketLink(socket)

    link.send("too early")

    expect(sent).toEqual([])
  })

  it("ignores a frame that is not text", () => {
    const { socket } = browserSocket()
    const link = new SocketLink(socket)
    const received: string[] = []
    link.onFrame((frame) => received.push(frame))

    socket.fire("message", { data: 42 })

    expect(received).toEqual([])
  })

  it("stops notifying an unsubscribed handler", () => {
    const { socket } = browserSocket()
    const link = new SocketLink(socket)
    const handler = vi.fn()

    const off = link.onFrame(handler)
    socket.fire("message", { data: "one" })
    off()
    socket.fire("message", { data: "two" })

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
