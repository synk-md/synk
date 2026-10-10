import { beforeEach, describe, expect, it } from "vitest"

import { generateSigningKey, randomBytes, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import { makeEnvelope, type Envelope } from "@/lib/sync"

import { RelayConnection } from "./connection"
import { LoopbackLink } from "./link"
import { RelayServer } from "./server"

const RELAY_ID = "did:relay:acme"
const NOTE_A = "notebook:travel/note:kyoto"
const NOTE_B = "notebook:travel/note:osaka"
const DEK = new Uint8Array(32).fill(7)

let server: RelayServer

beforeEach(() => {
  server = new RelayServer({ relayId: RELAY_ID })
})

async function party(): Promise<{ key: SigningKey; did: string }> {
  const key = await generateSigningKey()
  return { key, did: didFromSigningKey(key.publicKey) }
}

function connected(who: { key: SigningKey; did: string }) {
  const [clientLink, serverLink] = LoopbackLink.pair()
  server.accept(serverLink)
  const connection = new RelayConnection({
    link: clientLink,
    relayId: RELAY_ID,
    did: who.did,
    signingKey: who.key,
    timeoutMs: 2000,
  })
  return { connection, clientLink }
}

async function anEnvelope(
  author: { key: SigningKey; did: string },
  resourceId: string,
  seq: number,
): Promise<Envelope> {
  return makeEnvelope({
    signingKey: author.key,
    author: author.did,
    seq,
    resourceId,
    epoch: 1,
    dek: DEK,
    update: randomBytes(16),
  })
}

describe("one connection, many resources", () => {
  /** A notebook syncs several notes at once; a socket each would be wasteful. */
  it("serves a transport per resource over the same socket", async () => {
    const ada = await party()
    const { connection } = connected(ada)

    const a = connection.transportFor(NOTE_A)
    const b = connection.transportFor(NOTE_B)

    expect(a).not.toBe(b)
    // Asking twice gives the same transport, so a note has exactly one.
    expect(connection.transportFor(NOTE_A)).toBe(a)
    connection.close()
  })

  it("routes an envelope only to the note it belongs to", async () => {
    const ada = await party()
    const bob = await party()
    const author = connected(ada)
    const reader = connected(bob)

    const toA: Envelope[] = []
    const toB: Envelope[] = []
    reader.connection.transportFor(NOTE_A).subscribe((e) => toA.push(e))
    reader.connection.transportFor(NOTE_B).subscribe((e) => toB.push(e))
    await reader.connection.transportFor(NOTE_A).vector()

    await author.connection.transportFor(NOTE_A).publish(await anEnvelope(ada, NOTE_A, 1))

    expect(toA).toHaveLength(1)
    expect(toB).toHaveLength(0)

    author.connection.close()
    reader.connection.close()
  })

  it("keeps each resource's catch-up to itself", async () => {
    const ada = await party()
    const { connection } = connected(ada)

    await connection.transportFor(NOTE_A).publish(await anEnvelope(ada, NOTE_A, 1))
    await connection.transportFor(NOTE_B).publish(await anEnvelope(ada, NOTE_B, 1))
    await connection.transportFor(NOTE_B).publish(await anEnvelope(ada, NOTE_B, 2))

    expect(await connection.transportFor(NOTE_A).fetchSince({})).toHaveLength(1)
    expect(await connection.transportFor(NOTE_B).fetchSince({})).toHaveLength(2)
    connection.close()
  })

  it("authenticates once, not once per resource", async () => {
    const ada = await party()
    const { connection } = connected(ada)

    await connection.transportFor(NOTE_A).vector()
    await connection.transportFor(NOTE_B).vector()

    expect(server.metrics.authenticated).toBe(1)
    connection.close()
  })

  /**
   * After a reconnect the server remembers nothing. A resource left
   * unsubscribed receives no pushes, which looks exactly like nobody editing.
   */
  it("re-subscribes every resource after the link comes back", async () => {
    const ada = await party()
    const bob = await party()
    const author = connected(ada)
    const reader = connected(bob)

    const received: Envelope[] = []
    reader.connection.transportFor(NOTE_A).subscribe((e) => received.push(e))
    await reader.connection.transportFor(NOTE_A).vector()

    // The reader's socket drops and is replaced, as a reconnect would.
    reader.clientLink.setState("connecting")
    const [freshClient, freshServer] = LoopbackLink.pair()
    server.accept(freshServer)
    const reconnected = new RelayConnection({
      link: freshClient,
      relayId: RELAY_ID,
      did: bob.did,
      signingKey: bob.key,
      timeoutMs: 2000,
    })
    const afterwards: Envelope[] = []
    reconnected.transportFor(NOTE_A).subscribe((e) => afterwards.push(e))
    await reconnected.transportFor(NOTE_A).vector()

    await author.connection.transportFor(NOTE_A).publish(await anEnvelope(ada, NOTE_A, 1))

    expect(afterwards).toHaveLength(1)

    author.connection.close()
    reader.connection.close()
    reconnected.close()
  })

  it("stops delivering to a closed transport", async () => {
    const ada = await party()
    const bob = await party()
    const author = connected(ada)
    const reader = connected(bob)

    const received: Envelope[] = []
    const transport = reader.connection.transportFor(NOTE_A)
    transport.subscribe((e) => received.push(e))
    await transport.vector()
    transport.close()

    await author.connection.transportFor(NOTE_A).publish(await anEnvelope(ada, NOTE_A, 1))

    expect(received).toHaveLength(0)
    author.connection.close()
    reader.connection.close()
  })

  it("reports an empty vector when the relay cannot be reached", async () => {
    const ada = await party()
    const { connection } = connected(ada)
    await connection.transportFor(NOTE_A).publish(await anEnvelope(ada, NOTE_A, 1))

    server.available = false
    // Optimism here would make a reconnecting client drop its backlog.
    expect(await connection.transportFor(NOTE_A).vector()).toEqual({})
    connection.close()
  }, 10_000)
})
