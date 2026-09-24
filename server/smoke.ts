/**
 * Two clients, one relay, a real socket.
 *
 * Everything else in the suite drives the relay in-process, where both ends
 * share a `LoopbackLink` and no byte is ever framed. This is the only check
 * that the thing actually works over a wire: handshake, challenge-response
 * authentication, publish, fan-out and catch-up, against `pnpm relay`.
 *
 * Run the relay first. Exits non-zero when the round trip does not complete,
 * so it is usable as a smoke check rather than something to read the output of.
 */
import { WebSocket } from "ws"
import { generateSigningKey, randomBytes } from "../src/lib/crypto/index.ts"
import { didFromSigningKey } from "../src/lib/identity/index.ts"
import { makeEnvelope } from "../src/lib/sync/index.ts"
import { RelayClient, SocketLink } from "../src/lib/relay/index.ts"

const URL = process.env.RELAY_URL ?? "ws://localhost:4455"
const RELAY_ID = process.env.RELAY_ID ?? "did:relay:dev"
const RESOURCE = "notebook:smoke"
const DEK = new Uint8Array(32).fill(7)

async function connect(name: string) {
  const key = await generateSigningKey()
  const did = didFromSigningKey(key.publicKey)
  const socket = new WebSocket(URL)
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve())
    socket.on("error", reject)
  })
  const client = new RelayClient({
    link: new SocketLink(socket),
    relayId: RELAY_ID,
    did,
    signingKey: key,
    resourceId: RESOURCE,
    timeoutMs: 5000,
    onError: (e) => console.error(`${name} error`, e),
  })
  await client.vector()
  console.log(`${name} connected as ${did.slice(0, 24)}…`)
  return { client, key, did, socket }
}

const ada = await connect("ada")
const bob = await connect("bob")

const received: string[] = []
bob.client.subscribe((envelope) => received.push(envelope.sig.slice(0, 12)))

const envelope = await makeEnvelope({
  signingKey: ada.key,
  author: ada.did,
  seq: 1,
  resourceId: RESOURCE,
  epoch: 1,
  dek: DEK,
  update: randomBytes(24),
})
await ada.client.publish(envelope)
await new Promise((r) => setTimeout(r, 400))

console.log("bob received:", received.length, received)
console.log("ada vector:", await ada.client.vector())

const caught = await bob.client.fetchSince({})
console.log("catch-up returned:", caught.length)

ada.client.close(); bob.client.close()
ada.socket.close(); bob.socket.close()
const ok = received.length === 1 && caught.length === 1
console.log(ok ? "OK" : "FAILED")
process.exit(ok ? 0 : 1)
