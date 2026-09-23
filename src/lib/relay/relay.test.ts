import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import * as Y from "yjs"
import { beforeEach, describe, expect, it } from "vitest"

import { generateSigningKey, randomBytes, type Bytes, type SigningKey } from "@/lib/crypto"
import { deriveClientId, didFromSigningKey } from "@/lib/identity"
import {
  makeEnvelope,
  OfflineTransport,
  SyncEngine,
  type AuthorInfo,
  type Envelope,
} from "@/lib/sync"

import { signChallenge, verifyChallenge } from "./auth"
import { RelayClient } from "./client"
import { FailoverTransport } from "./failover"
import { LoopbackLink, WebSocketLink } from "./link"
import { MAX_SLICE_SIZE, RELAY_PROTOCOL_VERSION, type HostedRecord } from "./protocol"
import { EphemeralTurnIssuer, RelayServer, type RelayWriteHint } from "./server"
import { derivePhase, SyncStatusTracker } from "./status"

const RELAY_ID = "did:relay:acme"
const RESOURCE = "notebook:travel"
const WORKSPACE = "workspace:acme"

interface Party {
  key: SigningKey
  did: string
  clientId: number
}

async function party(): Promise<Party> {
  const key = await generateSigningKey()
  const did = didFromSigningKey(key.publicKey)
  return { key, did, clientId: await deriveClientId(key.publicKey) }
}

const DEK = new Uint8Array(32).fill(7)

async function anEnvelope(
  author: Party,
  seq: number,
  options: { resourceId?: string; update?: Bytes } = {},
): Promise<Envelope> {
  return makeEnvelope({
    signingKey: author.key,
    author: author.did,
    seq,
    resourceId: options.resourceId ?? RESOURCE,
    epoch: 1,
    dek: DEK,
    update: options.update ?? randomBytes(16),
  })
}

/** A server and one attached, authenticated client. */
async function connected(
  server: RelayServer,
  who: Party,
  options: { resourceId?: string } = {},
): Promise<{ client: RelayClient; link: LoopbackLink; serverLink: LoopbackLink }> {
  const [clientLink, serverLink] = LoopbackLink.pair()
  server.accept(serverLink)
  const client = new RelayClient({
    link: clientLink,
    relayId: RELAY_ID,
    did: who.did,
    signingKey: who.key,
    resourceId: options.resourceId ?? RESOURCE,
    timeoutMs: 2000,
  })
  // Any call drives the handshake to completion.
  await client.vector()
  return { client, link: clientLink, serverLink }
}

let server: RelayServer

beforeEach(() => {
  server = new RelayServer({ relayId: RELAY_ID })
})

/* ---- authentication ------------------------------------------------------ */

describe("relay authentication", () => {
  it("accepts a device that signs the challenge", async () => {
    const ada = await party()
    const challenge = "Y2hhbGxlbmdl"
    const sig = await signChallenge(ada.key, RELAY_ID, challenge)

    expect(await verifyChallenge(ada.did, RELAY_ID, challenge, sig)).toBe(true)
  })

  /** A challenge signed for one relay must not open a session on another. */
  it("refuses a challenge signed for a different relay", async () => {
    const ada = await party()
    const challenge = "Y2hhbGxlbmdl"
    const sig = await signChallenge(ada.key, "did:relay:evil", challenge)

    expect(await verifyChallenge(ada.did, RELAY_ID, challenge, sig)).toBe(false)
  })

  it("refuses every operation before authentication", async () => {
    const [clientLink, serverLink] = LoopbackLink.pair()
    server.accept(serverLink)
    const replies: string[] = []
    clientLink.onFrame((frame) => replies.push(frame))

    clientLink.send(JSON.stringify({ op: "publish", id: "1", envelope: {} }))
    await Promise.resolve()

    expect(replies[0]).toContain("not-authenticated")
    expect(server.metrics.refused["not-authenticated"]).toBe(1)
  })

  it("refuses a protocol version it does not speak", async () => {
    const [clientLink, serverLink] = LoopbackLink.pair()
    server.accept(serverLink)
    const replies: string[] = []
    clientLink.onFrame((frame) => replies.push(frame))

    clientLink.send(JSON.stringify({ op: "hello", id: "1", v: RELAY_PROTOCOL_VERSION + 99 }))
    await Promise.resolve()

    expect(replies[0]).toContain("unsupported-version")
  })
})

/* ---- store and forward --------------------------------------------------- */

describe("store and forward", () => {
  it("fans an envelope out to other subscribers of the same resource", async () => {
    const ada = await party()
    const bob = await party()
    const a = await connected(server, ada)
    const b = await connected(server, bob)

    const received: Envelope[] = []
    b.client.subscribe((envelope) => received.push(envelope))

    const envelope = await anEnvelope(ada, 1)
    await a.client.publish(envelope)

    expect(received).toHaveLength(1)
    expect(received[0].sig).toBe(envelope.sig)
  })

  it("does not fan out to a client subscribed elsewhere", async () => {
    const ada = await party()
    const bob = await party()
    const a = await connected(server, ada)
    const b = await connected(server, bob, { resourceId: "notebook:other" })

    const received: Envelope[] = []
    b.client.subscribe((envelope) => received.push(envelope))
    await a.client.publish(await anEnvelope(ada, 1))

    expect(received).toHaveLength(0)
  })

  it("holds envelopes for a client that was not connected, and serves them later", async () => {
    const ada = await party()
    const bob = await party()
    const a = await connected(server, ada)

    await a.client.publish(await anEnvelope(ada, 1))
    await a.client.publish(await anEnvelope(ada, 2))

    // Bob arrives afterwards and catches up.
    const b = await connected(server, bob)
    const caught = await b.client.fetchSince({})

    expect(caught).toHaveLength(2)
  })

  it("reports its vector so a reconnecting client knows what to push", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    await a.client.publish(await anEnvelope(ada, 1))

    expect(await a.client.vector()).toEqual({ [ada.did]: 1 })
  })
})

/* ---- the authorization fast path ----------------------------------------- */

describe("the authorization fast path", () => {
  const denyAll: RelayWriteHint = { mayWrite: () => false }

  it("declines to carry an envelope it is sure is unauthorized", async () => {
    const gated = new RelayServer({ relayId: RELAY_ID, hint: denyAll })
    const ada = await party()
    const bob = await party()
    const a = await connected(gated, ada)
    const b = await connected(gated, bob)

    const received: Envelope[] = []
    b.client.subscribe((envelope) => received.push(envelope))
    await a.client.publish(await anEnvelope(ada, 1))

    expect(received).toHaveLength(0)
    expect(gated.metrics.declinedByHint).toBe(1)
    expect(gated.store.envelopeCount(RESOURCE)).toBe(0)
  })

  /**
   * The relay is not an oracle. A distinct "you are not allowed" reply would be
   * a signal worth probing for, so a declined publish looks like any other.
   */
  it("does not tell the publisher it was declined", async () => {
    const gated = new RelayServer({ relayId: RELAY_ID, hint: denyAll })
    const ada = await party()
    const a = await connected(gated, ada)

    // No throw, no error surfaced: indistinguishable from an accepted publish.
    await expect(a.client.publish(await anEnvelope(ada, 1))).resolves.toBeUndefined()
  })

  /**
   * Failing open is right for an optimisation. Failing closed would let an
   * incomplete relay view silently stop real edits.
   */
  it("carries the envelope when it cannot evaluate the check", async () => {
    const unsure = new RelayServer({
      relayId: RELAY_ID,
      hint: { mayWrite: () => undefined },
    })
    const ada = await party()
    const bob = await party()
    const a = await connected(unsure, ada)
    const b = await connected(unsure, bob)

    const received: Envelope[] = []
    b.client.subscribe((envelope) => received.push(envelope))
    await a.client.publish(await anEnvelope(ada, 1))

    expect(received).toHaveLength(1)
  })

  /**
   * The whole point of the fast path being a fast path. A relay that says yes
   * changes nothing, because the client verifies regardless.
   */
  it("cannot make a client accept an envelope the client itself rejects", async () => {
    const permissive = new RelayServer({ relayId: RELAY_ID, hint: { mayWrite: () => true } })
    const ada = await party()
    const mallory = await party()
    const a = await connected(permissive, ada)
    const m = await connected(permissive, mallory)

    const doc = new Y.Doc()
    doc.clientID = ada.clientId
    const engine = new SyncEngine({
      doc,
      resourceId: RESOURCE,
      author: ada.did,
      signingKey: ada.key,
      clientId: ada.clientId,
      transport: a.client,
      authors: {
        resolve: (did) =>
          Promise.resolve(
            did === ada.did
              ? ({ publicKey: ada.key.publicKey, clientId: ada.clientId } satisfies AuthorInfo)
              : did === mallory.did
                ? ({ publicKey: mallory.key.publicKey, clientId: mallory.clientId } satisfies AuthorInfo)
                : undefined,
          ),
      },
      // The client's own policy. Mallory may not write here, whatever the
      // relay thinks.
      policy: { canWrite: (_resource, author) => author === ada.did },
      keys: {
        current: () => Promise.resolve({ epoch: 1, dek: DEK }),
        forEpoch: () => Promise.resolve(DEK),
      },
    })

    await m.client.publish(await anEnvelope(mallory, 1))
    await engine.flush()

    expect(engine.stats.rejected.unauthorized).toBe(1)
    expect(engine.stats.applied).toBe(0)
    engine.close()
  })
})

/* ---- archive and slices -------------------------------------------------- */

describe("the archive", () => {
  it("returns a bounded slice of history rather than everything", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    for (let seq = 1; seq <= 10; seq += 1) await a.client.publish(await anEnvelope(ada, seq))

    const slice = await a.client.fetchSlice({
      resourceId: RESOURCE,
      author: ada.did,
      fromSeq: 3,
      toSeq: 6,
    })

    expect(slice.envelopes.map((envelope) => envelope.seq)).toEqual([4, 5, 6])
    expect(slice.complete).toBe(true)
  })

  /** Silently returning less is how a client concludes it has caught up when it has not. */
  it("says so when a slice was truncated rather than quietly returning less", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    for (let seq = 1; seq <= MAX_SLICE_SIZE + 5; seq += 1) {
      server.store.append(await anEnvelope(ada, seq))
    }

    const slice = await a.client.fetchSlice({
      resourceId: RESOURCE,
      author: ada.did,
      fromSeq: 0,
      toSeq: MAX_SLICE_SIZE + 5,
    })

    expect(slice.envelopes).toHaveLength(MAX_SLICE_SIZE)
    expect(slice.complete).toBe(false)
  }, 30_000)

  it("keeps snapshots per resource and hands them back in deposit order", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    const snapshot = {
      id: "snap-1",
      resourceId: RESOURCE,
      author: ada.did,
    } as unknown as Parameters<typeof a.client.depositSnapshot>[0]

    await a.client.depositSnapshot(snapshot)
    await a.client.depositSnapshot(snapshot)

    expect(await a.client.fetchSnapshots(RESOURCE)).toHaveLength(1)
  })
})

/* ---- hosting ------------------------------------------------------------- */

describe("hosted records", () => {
  const record = (id: string, updatedAt: number): HostedRecord => ({
    kind: "directory",
    id,
    workspace: WORKSPACE,
    blob: `blob-${id}-${String(updatedAt)}`,
    updatedAt,
  })

  it("stores and returns records without interpreting them", async () => {
    const ada = await party()
    const a = await connected(server, ada)

    expect(await a.client.putRecords([record("r1", 10), record("r2", 10)])).toBe(2)
    expect(await a.client.getRecords(WORKSPACE)).toHaveLength(2)
  })

  it("filters by kind so a client is not handed the whole workspace", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    await a.client.putRecords([
      record("r1", 10),
      { kind: "prekey", id: "p1", workspace: WORKSPACE, blob: "x", updatedAt: 10 },
    ])

    expect(await a.client.getRecords(WORKSPACE, "prekey")).toHaveLength(1)
  })

  /** The relay cannot tell a rollback from a retry, but it can refuse to serve the older one. */
  it("will not roll a record back to an older version", async () => {
    const ada = await party()
    const a = await connected(server, ada)

    await a.client.putRecords([record("r1", 20)])
    await a.client.putRecords([record("r1", 10)])

    const [stored] = await a.client.getRecords(WORKSPACE)
    expect(stored.blob).toBe("blob-r1-20")
  })

  it("pushes a freshness summary to everyone attached", async () => {
    const ada = await party()
    const summaries: string[] = []
    const [clientLink, serverLink] = LoopbackLink.pair()
    server.accept(serverLink)
    const client = new RelayClient({
      link: clientLink,
      relayId: RELAY_ID,
      did: ada.did,
      signingKey: ada.key,
      resourceId: RESOURCE,
      onFreshness: (summary) => summaries.push(summary.blob),
    })
    await client.vector()

    server.broadcastSummary({ workspace: WORKSPACE, blob: "summary-1" })

    expect(summaries).toEqual(["summary-1"])
    expect(await client.fetchFreshness(WORKSPACE)).toEqual({
      workspace: WORKSPACE,
      blob: "summary-1",
    })
  })
})

/* ---- signaling and TURN -------------------------------------------------- */

describe("signaling", () => {
  it("carries an opaque payload between two authenticated devices", async () => {
    const ada = await party()
    const bob = await party()
    const received: { from: string; payload: string }[] = []

    await connected(server, ada)
    const [clientLink, serverLink] = LoopbackLink.pair()
    server.accept(serverLink)
    const bobClient = new RelayClient({
      link: clientLink,
      relayId: RELAY_ID,
      did: bob.did,
      signingKey: bob.key,
      resourceId: RESOURCE,
      onSignal: (from, payload) => received.push({ from, payload }),
    })
    await bobClient.vector()

    const [adaLink, adaServerLink] = LoopbackLink.pair()
    server.accept(adaServerLink)
    const adaClient = new RelayClient({
      link: adaLink,
      relayId: RELAY_ID,
      did: ada.did,
      signingKey: ada.key,
      resourceId: RESOURCE,
    })
    await adaClient.vector()
    await adaClient.sendSignal(bob.did, '{"kind":"offer","data":"sdp","resourceId":"x"}')

    expect(received).toHaveLength(1)
    expect(received[0].from).toBe(ada.did)
  })

  it("issues TURN credentials that expire and name the device", async () => {
    const issuer = new EphemeralTurnIssuer(["turn:turn.example:3478"], new Uint8Array(16).fill(3), 1000)
    const turning = new RelayServer({ relayId: RELAY_ID, turn: issuer, now: () => 5000 })
    const ada = await party()
    const a = await connected(turning, ada)

    const credentials = await a.client.turnCredentials()
    expect(credentials?.expiresAt).toBe(6000)
    expect(credentials?.username).toContain(ada.did)
    expect(credentials?.credential.length).toBeGreaterThan(0)
  })

  it("refuses TURN when the relay does not offer it", async () => {
    const ada = await party()
    const a = await connected(server, ada)
    expect(await a.client.turnCredentials()).toBeUndefined()
  })
})

/* ---- degradation --------------------------------------------------------- */

describe("degrading when the server is absent", () => {
  it("holds envelopes when nothing is reachable and sends them when it is", async () => {
    const ada = await party()
    const { client } = await connected(server, ada)
    let relayUp = false

    const failover = new FailoverTransport({
      transports: [{ transport: client, rank: 0, healthy: () => relayUp }],
    })

    await failover.publish(await anEnvelope(ada, 1))
    await failover.publish(await anEnvelope(ada, 2))
    expect(failover.pending).toBe(2)
    expect(failover.isolated).toBe(true)
    expect(server.store.envelopeCount(RESOURCE)).toBe(0)

    relayUp = true
    await failover.publish(await anEnvelope(ada, 3))

    expect(failover.pending).toBe(0)
    expect(server.store.envelopeCount(RESOURCE)).toBe(3)
  })

  it("prefers the relay and falls back to a peer link by rank", async () => {
    const ada = await party()
    const { client } = await connected(server, ada)
    const peer = new OfflineTransport()
    let relayUp = true
    const active: (string | null)[] = []

    const failover = new FailoverTransport({
      transports: [
        { transport: client, rank: 0, healthy: () => relayUp },
        { transport: peer, rank: 1, healthy: () => true },
      ],
      onActiveChange: (name) => active.push(name),
    })

    await failover.publish(await anEnvelope(ada, 1))
    relayUp = false
    await failover.publish(await anEnvelope(ada, 2))

    expect(active).toEqual(["relay", "offline"])
    expect(failover.isolated).toBe(false)
  })

  /** The exit criterion, as a test: an edit does not need the server. */
  it("applies and logs a local edit with no transport at all", async () => {
    const ada = await party()
    const doc = new Y.Doc()
    doc.clientID = ada.clientId
    const engine = new SyncEngine({
      doc,
      resourceId: RESOURCE,
      author: ada.did,
      signingKey: ada.key,
      clientId: ada.clientId,
      transport: new OfflineTransport(),
      authors: { resolve: () => Promise.resolve(undefined) },
      policy: { canWrite: () => true },
      keys: {
        current: () => Promise.resolve({ epoch: 1, dek: DEK }),
        forEpoch: () => Promise.resolve(DEK),
      },
    })

    engine.transact(() => {
      doc.getText("body").insert(0, "written on a train")
    })
    await engine.flush()

    expect(doc.getText("body").toJSON()).toBe("written on a train")
    // The envelope exists and is logged, so catch-up can offer it later.
    expect(engine.log.size).toBe(1)
    engine.close()
  })

  it("does not claim the relay holds anything while it is unreachable", async () => {
    const ada = await party()
    const { client } = await connected(server, ada)
    await client.publish(await anEnvelope(ada, 1))

    const failover = new FailoverTransport({
      transports: [{ transport: client, rank: 0, healthy: () => false }],
    })

    // An optimistic vector here would make a reconnecting client skip its
    // backlog, which is how an edit gets stranded on one device forever.
    expect(await failover.vector()).toEqual({})
  })

  it("survives the relay going unavailable mid-session without losing the log", async () => {
    const ada = await party()
    const { client } = await connected(server, ada)
    await client.publish(await anEnvelope(ada, 1))

    server.available = false
    // The request will time out rather than resolve; the client swallows it.
    const during = await client.fetchSince({})
    expect(during).toEqual([])

    server.available = true
    expect(await client.fetchSince({})).toHaveLength(1)
  }, 10_000)
})

/* ---- status -------------------------------------------------------------- */

describe("sync status", () => {
  /** The reassuring lie this surface exists to prevent. */
  it("never reports caught-up while offline with work pending", () => {
    expect(derivePhase("offline", 3, false)).toBe("offline-pending")
    expect(derivePhase("offline", 0, false)).toBe("offline-idle")
    expect(derivePhase("online", 3, false)).toBe("syncing")
    expect(derivePhase("online", 0, true)).toBe("syncing")
    expect(derivePhase("online", 0, false)).toBe("caught-up")
  })

  it("reports connection and phase to a subscriber as either changes", () => {
    const tracker = new SyncStatusTracker()
    const seen: string[] = []
    tracker.subscribe((status) => seen.push(`${status.connection}/${status.phase}`))

    // "connecting" leaves the phase alone but is worth telling a UI about, so
    // it emits: the two are reported independently on purpose.
    tracker.setConnection("connecting")
    tracker.setPending(2)
    tracker.setConnection("online")
    tracker.setPending(0)

    expect(seen).toEqual([
      "offline/offline-idle",
      "connecting/offline-idle",
      "connecting/offline-pending",
      "online/syncing",
      "online/caught-up",
    ])
  })

  it("records when a sync last succeeded, and the message when it failed", async () => {
    const tracker = new SyncStatusTracker()
    tracker.setConnection("online")

    await tracker.track(() => Promise.resolve("done"), () => 1234)
    expect(tracker.current.lastSyncedAt).toBe(1234)

    await expect(
      tracker.track(() => Promise.reject(new Error("relay unreachable"))),
    ).rejects.toThrow()
    expect(tracker.current.lastError).toBe("relay unreachable")
    // A failure does not erase the last time it worked.
    expect(tracker.current.lastSyncedAt).toBe(1234)
  })

  it("marks work in flight as syncing even with nothing pending", async () => {
    const tracker = new SyncStatusTracker()
    tracker.setConnection("online")
    let release = () => undefined as void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = tracker.track(() => gate)
    expect(tracker.current.phase).toBe("syncing")
    release()
    await running
    expect(tracker.current.phase).toBe("caught-up")
  })
})

/* ---- rate limiting ------------------------------------------------------- */

describe("rate limiting", () => {
  it("refuses a client sending faster than its allowance", async () => {
    const limited = new RelayServer({ relayId: RELAY_ID, rateLimit: 3, now: () => 1000 })
    const [clientLink, serverLink] = LoopbackLink.pair()
    limited.accept(serverLink)
    const replies: string[] = []
    clientLink.onFrame((frame) => replies.push(frame))

    for (let i = 0; i < 6; i += 1) {
      clientLink.send(JSON.stringify({ op: "hello", id: String(i), v: RELAY_PROTOCOL_VERSION }))
    }
    await Promise.resolve()

    expect(replies.filter((frame) => frame.includes("rate-limited")).length).toBeGreaterThan(0)
  })
})

/* ---- link reconnection --------------------------------------------------- */

describe("WebSocketLink", () => {
  class FakeSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    readonly sent: string[] = []
    send(frame: string) {
      this.sent.push(frame)
    }
    close() {
      this.onclose?.()
    }
  }

  /** Dropping them would turn a momentary reconnect into a lost edit. */
  it("queues frames written while disconnected and sends them on open", () => {
    let socket: FakeSocket | undefined
    const link = new WebSocketLink({
      url: "ws://relay.test",
      factory: () => {
        socket = new FakeSocket()
        return socket as unknown as WebSocket
      },
    })

    link.send("early")
    expect(socket?.sent).toEqual([])

    socket?.onopen?.()
    expect(socket?.sent).toEqual(["early"])
    link.close()
  })

  it("reports connecting rather than closed while it retries", () => {
    const states: string[] = []
    let socket: FakeSocket | undefined
    const link = new WebSocketLink({
      url: "ws://relay.test",
      factory: () => {
        socket = new FakeSocket()
        return socket as unknown as WebSocket
      },
    })
    link.onStateChange((state) => states.push(state))

    socket?.onopen?.()
    socket?.close()

    expect(states).toEqual(["open", "connecting"])
    link.close()
  })
})

/* ---- protocol hygiene ---------------------------------------------------- */

describe("the protocol", () => {
  /**
   * Structural rather than behavioural. If a field like this ever appears, a
   * client could read it instead of verifying, and the relay quietly becomes a
   * trust anchor. Cheap to assert now, expensive to discover later.
   */
  it("has no message in which the server asserts that something is valid", () => {
    const source = readFileSync(resolve(__dirname, "protocol.ts"), "utf8")

    expect(source).toContain("ServerReply")
    expect(source).not.toMatch(/\bauthorized\s*[?]?\s*:\s*boolean/)
    expect(source).not.toMatch(/\bverified\s*[?]?\s*:\s*boolean/)
    expect(source).not.toMatch(/\btrusted\s*[?]?\s*:\s*boolean/)
  })

  it("drops a malformed frame instead of throwing", () => {
    const [clientLink, serverLink] = LoopbackLink.pair()
    server.accept(serverLink)

    expect(() => clientLink.send("not json")).not.toThrow()
    expect(server.metrics.refused.malformed).toBe(1)
  })
})
