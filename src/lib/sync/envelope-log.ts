/**
 * Append-only log of signed envelopes, plus the per-author index the catch-up
 * handshake needs.
 *
 * Received originals are kept alongside locally authored ones, so any peer can
 * serve them onward without re-authoring anything.
 *
 * The delivery vector reports the highest *contiguous* sequence per author, not
 * the highest seen. With a gap at 5 a peer holding 1-4 and 6 must still be
 * offered 5, and reporting 6 would lose it forever.
 */

import type { Envelope } from "./envelope"

/** Highest contiguous sequence seen per author DID. */
export type DeliveryVector = Record<string, number>

interface AuthorState {
  bySeq: Map<number, Envelope>
  contiguousTo: number
}

export class EnvelopeLog {
  private readonly order: Envelope[] = []
  private readonly authors = new Map<string, AuthorState>()

  private state(author: string): AuthorState {
    let state = this.authors.get(author)
    if (!state) {
      state = { bySeq: new Map(), contiguousTo: 0 }
      this.authors.set(author, state)
    }
    return state
  }

  has(author: string, seq: number): boolean {
    return this.authors.get(author)?.bySeq.has(seq) ?? false
  }

  /** Returns false when the envelope was already held, so callers can dedup. */
  append(envelope: Envelope): boolean {
    const state = this.state(envelope.author)
    if (state.bySeq.has(envelope.seq)) return false

    state.bySeq.set(envelope.seq, envelope)
    this.order.push(envelope)

    // Advance the contiguous watermark over any gap this envelope just filled.
    while (state.bySeq.has(state.contiguousTo + 1)) state.contiguousTo += 1
    return true
  }

  get(author: string, seq: number): Envelope | undefined {
    return this.authors.get(author)?.bySeq.get(seq)
  }

  deliveryVector(): DeliveryVector {
    const vector: DeliveryVector = {}
    for (const [author, state] of this.authors) vector[author] = state.contiguousTo
    return vector
  }

  /**
   * Original envelopes beyond the asker's vector, ordered by author then
   * sequence so a receiver applies them in causal order per author.
   */
  selectSince(vector: DeliveryVector): Envelope[] {
    const out: Envelope[] = []
    for (const [author, state] of [...this.authors].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const from = vector[author] ?? 0
      for (let seq = from + 1; seq <= state.contiguousTo; seq += 1) {
        const envelope = state.bySeq.get(seq)
        if (envelope) out.push(envelope)
      }
    }
    return out
  }

  /**
   * Treat everything up to `vector` as already delivered, without holding it.
   *
   * What applying a snapshot does to the log. The snapshot's state already
   * contains those operations, so re-requesting them is pointless - and for a
   * joiner they are sealed under epochs it can never open, so it would ask
   * forever. Only ever raises a watermark; a lower claim is ignored.
   */
  markCovered(vector: DeliveryVector): void {
    for (const [author, covered] of Object.entries(vector)) {
      const state = this.state(author)
      if (covered > state.contiguousTo) state.contiguousTo = covered
      // A gap the snapshot bridged may make later held envelopes contiguous.
      while (state.bySeq.has(state.contiguousTo + 1)) state.contiguousTo += 1
    }
  }

  /** Highest sequence this author has authored here, for allocating the next. */
  highestSeq(author: string): number {
    const state = this.authors.get(author)
    if (!state) return 0
    let highest = 0
    for (const seq of state.bySeq.keys()) if (seq > highest) highest = seq
    return highest
  }

  all(): Envelope[] {
    return [...this.order]
  }

  get size(): number {
    return this.order.length
  }

  /** True when this exact envelope object came from this log, not synthesised. */
  holds(envelope: Envelope): boolean {
    return this.get(envelope.author, envelope.seq) === envelope
  }
}
