/**
 * The transport seam. Carries opaque envelopes and nothing else.
 *
 * **No transport is ever given a `Y.Doc`.** Nothing here mentions a document,
 * which keeps the rule structural. That disqualifies `y-protocols/sync`, which
 * answers a state-vector request with a merged diff nobody authored or signed:
 * convergence is fine, attributability is gone.
 *
 * Relay-first, since peers are usually not online together. A direct peer link
 * is a latency optimisation behind this same interface.
 */

import type { Snapshot } from "@/lib/snapshots/snapshot"
import type { Envelope } from "./envelope"
import type { DeliveryVector } from "./envelope-log"

export interface Transport {
  readonly name: string
  /** Send to whoever else is attached. */
  publish(envelope: Envelope): Promise<void>
  /** Live delivery. Returns an unsubscribe. */
  subscribe(handler: (envelope: Envelope) => void): () => void
  /**
   * Originals beyond the caller's vector, never a computed diff - a synthesised
   * update carries no author signature.
   */
  fetchSince(vector: DeliveryVector): Promise<Envelope[]>
  /**
   * The responder's vector, so catch-up runs both ways. A peer that authored
   * while disconnected would otherwise be stranded holding the only copy.
   */
  vector(): Promise<DeliveryVector>
  /**
   * How far each author's envelopes were let go behind an anchor. A device
   * behind it starts from that anchor. Absent where nothing is ever let go.
   */
  floor?(): Promise<DeliveryVector>
  /** Here so a joiner can collect it without any member being online. */
  depositSnapshot(snapshot: Snapshot): Promise<void>
  /** Archived snapshots for a resource, oldest first. */
  fetchSnapshots(resourceId: string): Promise<Snapshot[]>
  close(): void
}

/** A transport that drops everything, for a client with no connectivity. */
export class OfflineTransport implements Transport {
  readonly name = "offline"
  publish(): Promise<void> {
    return Promise.resolve()
  }
  subscribe(): () => void {
    return () => undefined
  }
  fetchSince(): Promise<Envelope[]> {
    return Promise.resolve([])
  }
  vector(): Promise<DeliveryVector> {
    return Promise.resolve({})
  }
  depositSnapshot(): Promise<void> {
    return Promise.resolve()
  }
  fetchSnapshots(): Promise<Snapshot[]> {
    return Promise.resolve([])
  }
  close(): void {
    // nothing to release
  }
}
