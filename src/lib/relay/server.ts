/**
 * The relay server: store-and-forward, hosting, archive, signaling.
 *
 * Transport-agnostic, so the same code runs behind a WebSocket and in-process
 * in a test. It never decrypts and never signs anything a client treats as
 * authority; withholding, delaying and disappearing are its only failure modes.
 *
 * The authorization check here is a fast path, never a decision - clients
 * re-verify regardless. It fails open, because failing closed would let an
 * incomplete relay view silently stop real edits.
 */

import { utf8 } from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"
import { verifySnapshot, type Snapshot } from "@/lib/snapshots"
import type { Envelope } from "@/lib/sync"
import { verifyGenesis, type WorkspaceGenesis } from "@/lib/workspace/genesis"
import { resolveLineage, type Standby, type Succession } from "@/lib/workspace/succession"
import { newChallenge, verifyChallenge } from "./auth"
import type { Link } from "./link"
import {
  decode,
  encode,
  MAX_SLICE_SIZE,
  RELAY_PROTOCOL_VERSION,
  type ClientMessage,
  type HostedSummary,
  type RelayErrorCode,
  type ServerMessage,
  type TurnCredentials,
} from "./protocol"
import { DEFAULT_PRUNE, RelayStore, type PrunePolicy, type RelayQuota } from "./server-store"

/** Whether the relay bothers carrying an envelope. Never a grant. */
export interface RelayWriteHint {
  /** False only when certain; undefined or true carries it. */
  mayWrite(resourceId: string, author: string): Promise<boolean | undefined> | boolean | undefined
}

export interface TurnIssuer {
  issue(did: string, now: number): Promise<TurnCredentials>
}

export interface RelayServerOptions {
  /** `did:key` or opaque id of this relay. Binds the auth challenge. */
  relayId: string
  quota?: RelayQuota
  prune?: PrunePolicy
  hint?: RelayWriteHint
  turn?: TurnIssuer
  now?: () => number
  /** Per-connection frames per second before requests are refused. */
  rateLimit?: number
}

interface Session {
  link: Link
  did?: string
  challenge: string
  resources: Set<string>
  /** Sliding window for the rate limiter. */
  recent: number[]
}

export interface RelayMetrics {
  connections: number
  authenticated: number
  published: number
  fannedOut: number
  declinedByHint: number
  /** Envelopes let go behind an owner's anchor. */
  pruned: number
  refused: Record<RelayErrorCode, number>
}

function emptyRefusals(): Record<RelayErrorCode, number> {
  return {
    "unsupported-version": 0,
    "not-authenticated": 0,
    "bad-signature": 0,
    "rate-limited": 0,
    "not-subscribed": 0,
    "unknown-resource": 0,
    malformed: 0,
    "quota-exceeded": 0,
    unavailable: 0,
  }
}

export class RelayServer {
  readonly store: RelayStore
  readonly metrics: RelayMetrics = {
    connections: 0,
    authenticated: 0,
    published: 0,
    fannedOut: 0,
    declinedByHint: 0,
    pruned: 0,
    refused: emptyRefusals(),
  }

  /** Set false to model the relay being unreachable without tearing links down. */
  available = true

  private readonly sessions = new Map<Link, Session>()
  private readonly options: RelayServerOptions
  private readonly now: () => number

  constructor(options: RelayServerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.store = new RelayStore(options.quota)
  }

  /** Attach a connected link. Returns a detach function. */
  accept(link: Link): () => void {
    const session: Session = {
      link,
      challenge: newChallenge(),
      resources: new Set(),
      recent: [],
    }
    this.sessions.set(link, session)
    this.metrics.connections += 1

    const off = link.onFrame((frame) => {
      void this.handle(session, frame)
    })
    return () => {
      off()
      this.sessions.delete(link)
    }
  }

  private send(session: Session, message: ServerMessage): void {
    if (!this.available) return
    session.link.send(encode(message))
  }

  private refuse(session: Session, id: string, error: RelayErrorCode, detail?: string): void {
    this.metrics.refused[error] += 1
    this.send(session, detail === undefined ? { id, ok: false, error } : { id, ok: false, error, detail })
  }

  private throttled(session: Session): boolean {
    const limit = this.options.rateLimit
    if (!limit) return false
    const now = this.now()
    session.recent = session.recent.filter((at) => now - at < 1000)
    if (session.recent.length >= limit) return true
    session.recent.push(now)
    return false
  }

  private async handle(session: Session, frame: string): Promise<void> {
    const message = decode<ClientMessage>(frame)
    if (!message || typeof message.op !== "string" || typeof message.id !== "string") {
      // No id to answer, and nothing to do but count it.
      this.metrics.refused.malformed += 1
      return
    }
    if (!this.available) return this.refuse(session, message.id, "unavailable")
    if (this.throttled(session)) return this.refuse(session, message.id, "rate-limited")

    // Only the handshake runs unauthenticated, so an anonymous connection
    // cannot fill the archive.
    if (message.op !== "hello" && message.op !== "auth" && !session.did) {
      return this.refuse(session, message.id, "not-authenticated")
    }

    switch (message.op) {
      case "hello": {
        if (message.v !== RELAY_PROTOCOL_VERSION) {
          return this.refuse(session, message.id, "unsupported-version", `expected ${String(RELAY_PROTOCOL_VERSION)}`)
        }
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "hello",
          v: RELAY_PROTOCOL_VERSION,
          challenge: session.challenge,
        })
      }

      case "auth": {
        const valid = await verifyChallenge(
          message.did,
          this.options.relayId,
          session.challenge,
          message.sig,
        )
        if (!valid) return this.refuse(session, message.id, "bad-signature")
        session.did = message.did
        this.metrics.authenticated += 1
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "auth",
          session: session.challenge,
          limits: { maxSlice: MAX_SLICE_SIZE },
        })
      }

      case "subscribe": {
        for (const resource of message.resources) session.resources.add(resource)
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "subscribe",
          resources: [...session.resources],
        })
      }

      case "publish":
        return this.publish(session, message.id, message.envelope)

      case "since":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "since",
          envelopes: this.store.since(message.resourceId, message.vector),
        })

      case "vector":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "vector",
          vector: this.store.vector(message.resourceId),
        })

      case "floor":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "floor",
          floor: this.store.floor(message.resourceId),
        })

      case "claim-owner":
        return this.claimOwner(session, message.id, message.genesis, message.deputies ?? [], message.standbys ?? [], message.successions ?? [])

      case "deposit-snapshot":
        return this.deposit(session, message.id, message.snapshot)

      case "snapshots":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "snapshots",
          snapshots: this.store.archived(message.resourceId),
        })

      case "slice": {
        const { envelopes, complete } = this.store.slice(message.request)
        return this.send(session, { id: message.id, ok: true, re: "slice", envelopes, complete })
      }

      case "records-get":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "records-get",
          records: this.store.getRecords(message.workspace, message.kind),
        })

      case "records-put":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "records-put",
          stored: this.store.putRecords(message.records),
        })

      case "freshness":
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "freshness",
          summary: this.store.getSummary(message.workspace) ?? null,
        })

      case "signal":
        return this.relaySignal(session, message.id, message.to, message.payload)

      case "turn": {
        if (!this.options.turn || !session.did) {
          return this.refuse(session, message.id, "unavailable")
        }
        return this.send(session, {
          id: message.id,
          ok: true,
          re: "turn",
          credentials: await this.options.turn.issue(session.did, this.now()),
        })
      }
    }
  }

  private async publish(session: Session, id: string, envelope: Envelope): Promise<void> {
    if (!envelope || typeof envelope.resourceId !== "string" || typeof envelope.author !== "string") {
      return this.refuse(session, id, "malformed")
    }

    // Fails open: declining on a cache miss would be silent data loss.
    const verdict = await this.options.hint?.mayWrite(envelope.resourceId, envelope.author)
    if (verdict === false) {
      this.metrics.declinedByHint += 1
      // Answered ok deliberately: a distinct refusal would be an oracle.
      return this.send(session, { id, ok: true, re: "publish" })
    }

    const fresh = this.store.append(envelope, this.now())
    this.metrics.published += 1
    this.send(session, { id, ok: true, re: "publish" })

    if (!fresh) return
    for (const [link, other] of this.sessions) {
      if (link === session.link) continue
      if (!other.did) continue
      if (!other.resources.has(envelope.resourceId)) continue
      this.metrics.fannedOut += 1
      this.send(other, { push: "envelope", envelope })
    }
  }

  private async deposit(session: Session, id: string, snapshot: Snapshot): Promise<void> {
    if (!snapshot || typeof snapshot.resourceId !== "string") {
      return this.refuse(session, id, "malformed")
    }
    // Checked so that only a snapshot its author really signed can be an anchor.
    // An unsigned one is still archived: clients verify for themselves.
    let signed = false
    try {
      signed = await verifySnapshot(snapshot, publicKeyFromDid(snapshot.author, "ed25519"))
    } catch {
      signed = false
    }
    this.store.archive(snapshot, { signed })
    this.send(session, { id, ok: true, re: "deposit-snapshot" })
    if (signed) this.prune(snapshot.resourceId)
  }

  /** Only the owner's own device, with a genesis that verifies. */
  private async claimOwner(
    session: Session,
    id: string,
    genesis: WorkspaceGenesis,
    deputies: readonly string[],
    standbys: readonly Standby[],
    successions: readonly Succession[],
  ): Promise<void> {
    if (!genesis || !(await verifyGenesis(genesis))) return this.refuse(session, id, "malformed")
    if (![deputies, standbys, successions].every(Array.isArray) || deputies.some((did) => typeof did !== "string")) {
      return this.refuse(session, id, "malformed")
    }
    // The same rules the devices follow: only the owner now may claim.
    const lineage = await resolveLineage(genesis, standbys, successions)
    if (lineage.status !== "established" || lineage.owner !== session.did) return this.refuse(session, id, "malformed")
    this.store.claimOwnership(genesis, deputies, lineage.owners)
    this.send(session, { id, ok: true, re: "claim-owner" })
  }

  private prune(resourceId: string): number {
    const dropped = this.store.prune(resourceId, this.now(), this.options.prune ?? DEFAULT_PRUNE)
    this.metrics.pruned += dropped
    return dropped
  }

  /** Let go of whatever has aged behind an anchor. Run now and then. */
  sweep(): number {
    let dropped = 0
    for (const resourceId of this.store.resourceIds) dropped += this.prune(resourceId)
    return dropped
  }

  /**
   * Carry an opaque blob between two authenticated devices. The relay stays
   * required for signaling and traversal even once WebRTC carries the live hop.
   */
  private relaySignal(session: Session, id: string, to: string, payload: string): void {
    for (const [, other] of this.sessions) {
      if (other.did !== to || !session.did) continue
      this.send(other, { push: "signal", from: session.did, payload })
    }
    this.send(session, { id, ok: true, re: "signal" })
  }

  /** Publish a freshness summary to everyone attached. */
  broadcastSummary(summary: HostedSummary): void {
    this.store.putSummary(summary)
    for (const [, session] of this.sessions) {
      if (!session.did) continue
      this.send(session, { push: "freshness", summary })
    }
  }

  get sessionCount(): number {
    return this.sessions.size
  }
}

/**
 * The ephemeral TURN REST scheme: expiry in the username, HMAC as the
 * credential, no per-user state. Short-lived and DID-bound, because a leaked
 * credential is otherwise free bandwidth for whoever finds it.
 */
export class EphemeralTurnIssuer implements TurnIssuer {
  private readonly urls: string[]
  private readonly secret: Uint8Array
  private readonly ttlMs: number
  private key: Promise<CryptoKey> | undefined

  constructor(urls: string[], secret: Uint8Array, ttlMs = 60 * 60 * 1000) {
    this.urls = urls
    this.secret = secret
    this.ttlMs = ttlMs
  }

  private hmacKey(): Promise<CryptoKey> {
    // SHA-1 as the TURN REST scheme specifies. A MAC under a secret key, not
    // a collision-resistance claim.
    this.key ??= crypto.subtle.importKey(
      "raw",
      this.secret as BufferSource,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    )
    return this.key
  }

  async issue(did: string, now: number): Promise<TurnCredentials> {
    const expiresAt = now + this.ttlMs
    const username = `${String(Math.floor(expiresAt / 1000))}:${did}`
    const mac = await crypto.subtle.sign("HMAC", await this.hmacKey(), utf8(username) as BufferSource)
    return {
      urls: [...this.urls],
      username,
      credential: toBase64(new Uint8Array(mac)),
      expiresAt,
    }
  }
}

/** The TURN REST scheme specifies standard base64 for the credential. */
function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
