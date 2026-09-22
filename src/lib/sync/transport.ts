/**
 * The transport seam. Carries opaque envelopes and nothing else.
 *
 * **No transport is ever given a `Y.Doc`.** Only the envelope layer holds one.
 * Nothing in this interface mentions a document, which is what keeps the rule
 * structural rather than a convention someone has to remember.
 *
 * That rule disqualifies the standard Yjs sync protocol and every provider
 * built on it. `y-protocols/sync` answers a state-vector request with
 * `Y.encodeStateAsUpdate(doc, sv)` - a merged diff nobody authored and nobody
 * signed. It converges correctly, which is exactly why the hazard is easy to
 * miss: convergence is fine, attributability is gone. A provider that needs the
 * document in order to synthesise that diff cannot be made safe by wrapping it.
 *
 * Relay-first: the relay is the backbone because peers are usually not online
 * together, and it is trusted for liveness only - it can delay or withhold, but
 * every envelope it carries is verified independently on arrival, so it cannot
 * forge or read anything. A direct peer link, if added, is a latency
 * optimisation behind this same interface, carrying the same opaque envelopes.
 */

import type { Envelope } from "./envelope"
import type { DeliveryVector } from "./envelope-log"

export interface Transport {
  readonly name: string
  /** Send to whoever else is attached. */
  publish(envelope: Envelope): Promise<void>
  /** Live delivery. Returns an unsubscribe. */
  subscribe(handler: (envelope: Envelope) => void): () => void
  /**
   * Catch-up: originals beyond the caller's vector.
   *
   * The responder may only return envelopes it actually holds. It must never
   * compute a merged diff - a synthesised update carries no author signature,
   * so an untrusted responder could tamper with it undetectably.
   */
  fetchSince(vector: DeliveryVector): Promise<Envelope[]>
  /**
   * The responder's own delivery vector.
   *
   * Catch-up has to run both ways. A peer that authored while disconnected
   * holds envelopes the relay never saw, and pulling alone would strand them
   * there forever - so the reconnecting side asks what the responder is missing
   * and pushes it.
   */
  vector(): Promise<DeliveryVector>
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
  close(): void {
    // nothing to release
  }
}
