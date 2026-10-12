/**
 * The relay, as a process.
 *
 * `RelayServer` already speaks the whole protocol over a `Link`; this is the
 * socket it was missing. Every connection becomes a link and is handed over,
 * so the thing running here is the same code the tests drive in-process and
 * the same code that would run in production.
 *
 * Development-grade on purpose. There is no TLS, no billing, no persistence and
 * no authentication of the *operator* - the relay stores what it is given and
 * hands it back. What it cannot do is read any of it, which is the property
 * that makes running an unhardened one acceptable while the client is being
 * built against it.
 */

import { createServer, type IncomingMessage } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"

import { BlobStore, handleBlobRequest, RelayServer, SocketLink } from "../src/lib/relay/index.ts"

const PORT = Number(process.env.RELAY_PORT ?? 4455)
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"

const relay = new RelayServer({
  relayId: RELAY_ID,
  // A generous ceiling. It exists so one client cannot spin the process, not
  // as a real quota - that belongs with the billing this does not have.
  rateLimit: 200,
})

const blobs = new BlobStore()

/** The body, or null once it passes `limit` - stopped being kept, not buffered. */
function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers["content-length"] ?? 0) > limit) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
    request.on("error", reject)
  })
}

const http = createServer((request, response) => {
  if (request.url?.startsWith("/blobs/")) {
    void (async () => {
      const body = request.method === "PUT" ? await readBody(request, blobs.quota.maxBlobBytes) : undefined
      if (body === null) {
        // Answered before the rest arrives, then closed: the client is told
        // why rather than seeing its upload cut off.
        response.writeHead(413, { "access-control-allow-origin": "*", connection: "close" })
        response.end(() => request.destroy())
        return
      }
      const reply = handleBlobRequest(blobs, {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        ...(body ? { body } : {}),
      })
      response.writeHead(reply?.status ?? 404, reply?.headers)
      response.end(reply?.body && request.method !== "HEAD" ? Buffer.from(reply.body) : undefined)
    })().catch(() => {
      response.writeHead(500)
      response.end()
    })
    return
  }

  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        relayId: RELAY_ID,
        sessions: relay.sessionCount,
        resources: relay.store.resourceCount,
        imageBytes: blobs.bytesHeld,
        metrics: relay.metrics,
      }),
    )
    return
  }
  response.writeHead(404)
  response.end()
})

const sockets = new WebSocketServer({ server: http })

sockets.on("connection", (socket: WebSocket) => {
  const link = new SocketLink(socket)
  const detach = relay.accept(link)

  socket.on("close", detach)
  socket.on("error", detach)
})

http.listen(PORT, () => {
  console.log(`relay listening on ws://localhost:${String(PORT)} as ${RELAY_ID}`)
  console.log(`health at http://localhost:${String(PORT)}/health`)
})

function shutdown(): void {
  console.log("relay shutting down")
  sockets.close()
  http.close(() => process.exit(0))
  // Nothing here is durable, so there is nothing to flush - but say so rather
  // than exiting silently and leaving the impression something was saved.
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
