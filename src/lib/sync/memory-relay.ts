/**
 * Store-and-forward relay, in memory.
 *
 * The relay logic is real: it retains every envelope it is given, fans out to
 * connected clients, and answers catch-up from its own store. Only the socket
 * is missing - putting this behind a WebSocket is M8.
 *
 * It never decrypts, never verifies, and is never asked to be honest: clients
 * re-verify everything, so the worst it can do is withhold or delay.
 */

import type { Snapshot } from "@/lib/snapshots/snapshot"
import { EnvelopeLog, type DeliveryVector } from "./envelope-log"
import type { Envelope } from "./envelope"
import type { Transport } from "./transport"

export class MemoryRelay {
  private readonly log = new EnvelopeLog()
  /** The archive: snapshots by resource, in deposit order. */
  private readonly snapshots = new Map<string, Snapshot[]>()
  private readonly clients = new Set<RelayTransport>()
  /** Set false to model an outage; envelopes stop flowing, nothing is lost. */
  online = true

  attach(name: string): RelayTransport {
    const client = new RelayTransport(this, name)
    this.clients.add(client)
    return client
  }

  detach(client: RelayTransport): void {
    this.clients.delete(client)
  }

  accept(from: RelayTransport, envelope: Envelope): void {
    this.log.append(envelope)
    if (!this.online) return
    for (const client of this.clients) {
      if (client !== from && client.connected) client.deliver(envelope)
    }
  }

  since(vector: DeliveryVector): Envelope[] {
    return this.online ? this.log.selectSince(vector) : []
  }

  /** What the relay already holds, so a client knows what to push. */
  vector(): DeliveryVector {
    return this.log.deliveryVector()
  }

  /** Let envelopes go, as a relay does behind an anchor. */
  prune(vector: DeliveryVector): number {
    return this.log.prune(vector)
  }

  floor(): DeliveryVector {
    return this.log.floor()
  }

  /** Everything the relay is holding. Ciphertext only. */
  stored(): Envelope[] {
    return this.log.all()
  }

  archive(snapshot: Snapshot): void {
    const held = this.snapshots.get(snapshot.resourceId) ?? []
    if (held.some((existing) => existing.id === snapshot.id)) return
    this.snapshots.set(snapshot.resourceId, [...held, snapshot])
  }

  archived(resourceId: string): Snapshot[] {
    return this.online ? [...(this.snapshots.get(resourceId) ?? [])] : []
  }

  get size(): number {
    return this.log.size
  }
}

export class RelayTransport implements Transport {
  private readonly handlers = new Set<(envelope: Envelope) => void>()
  /** Set false to model this client being disconnected while the relay runs. */
  connected = true

  private readonly relay: MemoryRelay
  readonly name: string

  constructor(relay: MemoryRelay, name: string) {
    this.relay = relay
    this.name = name
  }

  publish(envelope: Envelope): Promise<void> {
    if (this.connected) this.relay.accept(this, envelope)
    return Promise.resolve()
  }

  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  fetchSince(vector: DeliveryVector): Promise<Envelope[]> {
    return Promise.resolve(this.connected ? this.relay.since(vector) : [])
  }

  vector(): Promise<DeliveryVector> {
    // A disconnected client must not conclude the relay has everything, or it
    // would skip pushing its backlog on reconnect.
    return Promise.resolve(this.connected ? this.relay.vector() : {})
  }

  floor(): Promise<DeliveryVector> {
    return Promise.resolve(this.connected ? this.relay.floor() : {})
  }

  depositSnapshot(snapshot: Snapshot): Promise<void> {
    if (this.connected) this.relay.archive(snapshot)
    return Promise.resolve()
  }

  fetchSnapshots(resourceId: string): Promise<Snapshot[]> {
    return Promise.resolve(this.connected ? this.relay.archived(resourceId) : [])
  }

  deliver(envelope: Envelope): void {
    for (const handler of this.handlers) handler(envelope)
  }

  close(): void {
    this.handlers.clear()
    this.relay.detach(this)
  }
}
