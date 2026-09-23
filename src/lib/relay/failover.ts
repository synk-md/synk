/**
 * Degrading to peer-to-peer, and to nothing at all.
 *
 * Authorization and editing never depended on the server - chains are verified
 * locally, and an update is applied and enveloped before any transport is
 * touched. Delivery is what needs handling, so envelopes written while
 * everything is down are held rather than dropped.
 */

import type { Snapshot } from "@/lib/snapshots"
import type { DeliveryVector, Envelope, Transport } from "@/lib/sync"

export type TransportHealth = "up" | "down"

export interface RankedTransport {
  transport: Transport
  /** Lower is preferred. The relay is 0; a direct peer link is 1. */
  rank: number
  healthy(): boolean
}

export interface FailoverOptions {
  transports: readonly RankedTransport[]
  /** Envelopes held while nothing is up. Oldest shed beyond this. */
  maxBacklog?: number
  onActiveChange?: (name: string | null) => void
}

/**
 * Sends over the best healthy transport and holds what it cannot send. One
 * active at a time rather than a try-each loop, so the status display cannot
 * show a slow fallback succeeding while the fast one is merely busy.
 */
export class FailoverTransport implements Transport {
  readonly name = "failover"

  private readonly options: FailoverOptions
  private readonly handlers = new Set<(envelope: Envelope) => void>()
  private readonly unsubscribes: (() => void)[] = []
  /** Authored while nothing was up. */
  private backlog: Envelope[] = []
  private lastActive: string | null = null

  constructor(options: FailoverOptions) {
    this.options = options
    for (const entry of options.transports) {
      this.unsubscribes.push(
        entry.transport.subscribe((envelope) => {
          for (const handler of this.handlers) handler(envelope)
        }),
      )
    }
  }

  /** The preferred healthy transport, or null when everything is down. */
  active(): Transport | null {
    const healthy = this.options.transports
      .filter((entry) => entry.healthy())
      .sort((a, b) => a.rank - b.rank)
    const chosen = healthy[0]?.transport ?? null

    const name = chosen?.name ?? null
    if (name !== this.lastActive) {
      this.lastActive = name
      this.options.onActiveChange?.(name)
    }
    return chosen
  }

  get pending(): number {
    return this.backlog.length
  }

  /** True when there is no route out at all - the offline indicator's source. */
  get isolated(): boolean {
    return this.options.transports.every((entry) => !entry.healthy())
  }

  async publish(envelope: Envelope): Promise<void> {
    const transport = this.active()
    if (!transport) {
      this.hold(envelope)
      return
    }
    await transport.publish(envelope)
    await this.drain(transport)
  }

  private hold(envelope: Envelope): void {
    const max = this.options.maxBacklog ?? 10_000
    this.backlog.push(envelope)
    // Survivable only because the engine's log still holds every original and
    // catch-up will offer them again. This is a fast path, not the only copy.
    if (this.backlog.length > max) this.backlog = this.backlog.slice(-max)
  }

  private async drain(transport: Transport): Promise<void> {
    if (this.backlog.length === 0) return
    const held = this.backlog
    this.backlog = []
    for (const envelope of held) await transport.publish(envelope)
  }

  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async fetchSince(vector: DeliveryVector): Promise<Envelope[]> {
    const transport = this.active()
    if (!transport) return []
    const envelopes = await transport.fetchSince(vector)
    await this.drain(transport)
    return envelopes
  }

  async vector(): Promise<DeliveryVector> {
    const transport = this.active()
    // Optimism here would strand the backlog on reconnect.
    return transport ? transport.vector() : {}
  }

  async depositSnapshot(snapshot: Snapshot): Promise<void> {
    await this.active()?.depositSnapshot(snapshot)
  }

  async fetchSnapshots(resourceId: string): Promise<Snapshot[]> {
    return (await this.active()?.fetchSnapshots(resourceId)) ?? []
  }

  close(): void {
    for (const off of this.unsubscribes) off()
    this.handlers.clear()
    for (const entry of this.options.transports) entry.transport.close()
  }
}
