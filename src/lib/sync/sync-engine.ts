/**
 * The interposition point: the Yjs update boundary.
 *
 * Outbound, a local update is encrypted, signed, logged and published.
 * Inbound, an envelope is verified, authorised, deduped, decrypted, checked for
 * client-id forgery, and only then applied with a REMOTE origin so it is never
 * re-signed and re-broadcast.
 *
 * The update event is synchronous and cannot await, so the handler does the one
 * thing that must be synchronous - claiming the sequence number, which fixes
 * this edit's place in per-author order - and chains the crypto and the
 * publish onto a serial queue behind it.
 */

import * as Y from "yjs"
import type { Bytes, SigningKey } from "@/lib/crypto"
import {
  makeEnvelope,
  openEnvelope,
  verifyEnvelopeSignature,
  isEnvelopeShaped,
  type Envelope,
} from "./envelope"
import { EnvelopeLog, type DeliveryVector } from "./envelope-log"
import { checkUpdateAuthorship } from "./update-guard"
import type { Transport } from "./transport"
import { openSnapshot, type Snapshot } from "@/lib/snapshots/snapshot"

/** Tags a transaction as an applied remote update. Closes the feedback loop. */
export const REMOTE_ORIGIN = Symbol("synk/remote")
/** Tags a local edit made through this engine. */
export const LOCAL_ORIGIN = Symbol("synk/local")

export interface AuthorInfo {
  /** Raw Ed25519 public key of the author's signing device. */
  publicKey: Bytes
  /** The one Yjs client id that device may use, derived in M2. */
  clientId: number
}

/**
 * Resolves an author DID to its key and permitted client id, normally backed by
 * the verified directory (M3). Returning undefined rejects the envelope.
 */
export interface AuthorResolver {
  resolve(did: string): Promise<AuthorInfo | undefined>
}

/**
 * Whether an author may write to a resource. A placeholder for the capability
 * chains of M6 - today this is membership, not a delegation walk.
 */
export interface WritePolicy {
  canWrite(resourceId: string, authorDid: string): Promise<boolean> | boolean
}

/** Supplies content keys. M5 replaces this with the real epoch keyring. */
export interface EpochKeyProvider {
  current(): Promise<{ epoch: number; dek: Bytes }>
  forEpoch(epoch: number): Promise<Bytes | undefined>
}

export type RejectionReason =
  | "malformed"
  | "bad-snapshot"
  | "unsupported-kind"
  | "unknown-author"
  | "bad-signature"
  | "unauthorized"
  | "wrong-resource"
  | "duplicate"
  | "unknown-epoch"
  | "undecryptable"
  | "forged-client-id"

export interface SyncResult {
  /** Envelopes applied from the responder. */
  pulled: number
  /** Envelopes handed back because the responder lacked them. */
  pushed: number
}

export interface SyncStats {
  published: number
  applied: number
  snapshotsApplied: number
  duplicates: number
  rejected: Record<RejectionReason, number>
}

function emptyStats(): SyncStats {
  return {
    published: 0,
    applied: 0,
    snapshotsApplied: 0,
    duplicates: 0,
    rejected: {
      malformed: 0,
      "bad-snapshot": 0,
      "unsupported-kind": 0,
      "unknown-author": 0,
      "bad-signature": 0,
      unauthorized: 0,
      "wrong-resource": 0,
      duplicate: 0,
      "unknown-epoch": 0,
      undecryptable: 0,
      "forged-client-id": 0,
    },
  }
}

export interface SyncEngineOptions {
  doc: Y.Doc
  resourceId: string
  /** This device's own identity. */
  author: string
  signingKey: SigningKey
  /** This device's derived client id. The document must already be pinned to it. */
  clientId: number
  transport: Transport
  authors: AuthorResolver
  policy: WritePolicy
  keys: EpochKeyProvider
  /** Surfaced rather than thrown - an outbound failure must not break editing. */
  onError?: (error: unknown) => void
}

export class SyncEngine {
  readonly log = new EnvelopeLog()
  readonly stats: SyncStats = emptyStats()

  private readonly options: SyncEngineOptions
  private readonly unsubscribe: () => void
  private readonly updateHandler: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    transaction: Y.Transaction,
  ) => void
  private outbound: Promise<void> = Promise.resolve()
  /**
   * Inbound is serialised, not merely awaited. Two concurrent `receive` calls
   * could both pass the dedup check before either appends to the log, applying
   * one envelope twice; chaining them makes check-then-append atomic.
   */
  private inbound: Promise<void> = Promise.resolve()
  private localSeq = 0
  private closed = false

  constructor(options: SyncEngineOptions) {
    this.options = options

    this.updateHandler = (update, origin, _doc, transaction) => {
      // Loop guard: an applied remote update must never be re-signed and
      // re-broadcast. Checked on the origin rather than on content, since a
      // remote update can be byte-identical to something we would author.
      if (origin === REMOTE_ORIGIN) return
      if (!transaction.local) return
      this.enqueueOutbound(update)
    }
    options.doc.on("update", this.updateHandler)

    this.unsubscribe = options.transport.subscribe((envelope) => {
      this.enqueueInbound(envelope)
    })
  }

  /** Apply a local edit. Tagging the origin keeps the loop guard honest. */
  transact(fn: () => void): void {
    this.options.doc.transact(fn, LOCAL_ORIGIN)
  }

  private enqueueOutbound(update: Uint8Array): void {
    const seq = ++this.localSeq // synchronous: pins this edit's place in order
    this.outbound = this.outbound
      .then(async () => {
        if (this.closed) return
        const { epoch, dek } = await this.options.keys.current()
        const envelope = await makeEnvelope({
          signingKey: this.options.signingKey,
          author: this.options.author,
          seq,
          resourceId: this.options.resourceId,
          epoch,
          dek,
          update,
        })
        this.log.append(envelope)
        this.stats.published += 1
        await this.options.transport.publish(envelope)
      })
      .catch((error: unknown) => {
        this.options.onError?.(error)
      })
  }

  private enqueueInbound(envelope: Envelope): void {
    this.inbound = this.inbound
      .then(() => this.receive(envelope))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.onError?.(error)
      })
  }

  /**
   * Settle queued work in both directions. Outbound first, because publishing
   * is what hands a peer something to receive; then inbound; then outbound
   * again, so anything the inbound side scheduled has drained too.
   */
  async flush(): Promise<void> {
    await this.outbound
    await this.inbound
    await this.outbound
  }

  /** True when nothing is queued in either direction. */
  async isQuiescent(): Promise<boolean> {
    const marker = Symbol("marker")
    const outboundDone = await Promise.race([this.outbound.then(() => marker), Promise.resolve(null)])
    const inboundDone = await Promise.race([this.inbound.then(() => marker), Promise.resolve(null)])
    return outboundDone === marker && inboundDone === marker
  }

  private reject(reason: RejectionReason): false {
    this.stats.rejected[reason] += 1
    return false
  }

  /**
   * The inbound pipeline. Order is the security property: nothing
   * attacker-supplied is decrypted before it is both authentic and authorised.
   *
   * Returns whether the envelope was applied, so catch-up can report progress.
   */
  async receive(envelope: Envelope): Promise<boolean> {
    if (this.closed) return false
    if (!isEnvelopeShaped(envelope)) return this.reject("malformed")
    // Only document updates are handled here. A presence envelope is a
    // well-formed thing this engine has no handler for, counted separately so
    // it is visible rather than silently dropped as malformed.
    if (envelope.kind !== "update") return this.reject("unsupported-kind")
    if (envelope.resourceId !== this.options.resourceId) return this.reject("wrong-resource")

    const author = await this.options.authors.resolve(envelope.author)
    if (!author) return this.reject("unknown-author")

    if (!(await verifyEnvelopeSignature(envelope, author.publicKey)))
      return this.reject("bad-signature")

    if (!(await this.options.policy.canWrite(envelope.resourceId, envelope.author)))
      return this.reject("unauthorized")

    // Idempotent replay: already held, nothing to do.
    if (this.log.has(envelope.author, envelope.seq)) {
      this.stats.duplicates += 1
      return false
    }

    const dek = await this.options.keys.forEpoch(envelope.epoch)
    if (!dek) return this.reject("unknown-epoch")

    let update: Bytes
    try {
      update = await openEnvelope(envelope, dek)
    } catch {
      return this.reject("undecryptable")
    }

    // The attribution-integrity invariant, enforced. An update whose operations
    // claim a client id other than its author's is refused outright.
    if (!checkUpdateAuthorship(update, author.clientId).ok)
      return this.reject("forged-client-id")

    // Store before applying, so a peer can serve this original onward even if
    // the apply throws.
    this.log.append(envelope)
    Y.applyUpdate(this.options.doc, update, REMOTE_ORIGIN)
    this.stats.applied += 1
    return true
  }

  deliveryVector(): DeliveryVector {
    return this.log.deliveryVector()
  }

  /**
   * Adopt a snapshot: verify, decrypt, apply, and advance the delivery vector
   * to the point it covers.
   *
   * This is the one place a merged, unauthored artifact is accepted, and only
   * from a resolvable author who is authorised to write here - someone who
   * could already put arbitrary content in the document. The client-id check
   * that guards ordinary updates deliberately does not apply: a snapshot
   * contains every author's operations by construction.
   *
   * Applying it is what re-establishes a clean per-author causal baseline, so
   * subsequent edits from pre-existing authors can place.
   */
  async applySnapshot(
    snapshot: Snapshot,
    verify: (snapshot: Snapshot, author: AuthorInfo) => Promise<boolean>,
  ): Promise<boolean> {
    if (this.closed) return false
    if (snapshot?.resourceId !== this.options.resourceId) return this.reject("wrong-resource")

    const author = await this.options.authors.resolve(snapshot.author)
    if (!author) return this.reject("unknown-author")
    if (!(await verify(snapshot, author))) return this.reject("bad-snapshot")
    if (!(await this.options.policy.canWrite(snapshot.resourceId, snapshot.author)))
      return this.reject("unauthorized")

    const dek = await this.options.keys.forEpoch(snapshot.epoch)
    if (!dek) return this.reject("unknown-epoch")

    let state: Bytes
    try {
      state = await openSnapshot(snapshot, dek)
    } catch {
      return this.reject("undecryptable")
    }

    Y.applyUpdate(this.options.doc, state, REMOTE_ORIGIN)
    this.log.markCovered(snapshot.covers)
    this.stats.snapshotsApplied += 1
    return true
  }

  /** The point in the log a snapshot taken now would cover. */
  snapshotCoverage(): DeliveryVector {
    return this.log.deliveryVector()
  }

  /**
   * Catch-up, in both directions.
   *
   * Pull: the ORIGINAL signed envelopes the responder holds beyond our vector,
   * each verified individually - never a synthesised diff, which would carry no
   * author signature and so could be tampered with by whoever served it.
   *
   * Push: whatever the responder is missing. A peer that authored while
   * disconnected holds envelopes nobody else has, and pulling alone would leave
   * them stranded on that device.
   */
  async sync(): Promise<SyncResult> {
    const incoming = await this.options.transport.fetchSince(this.deliveryVector())
    let pulled = 0
    for (const envelope of incoming) {
      if (await this.receive(envelope)) pulled += 1
    }

    const theirs = await this.options.transport.vector()
    const outgoing = this.log.selectSince(theirs)
    for (const envelope of outgoing) await this.options.transport.publish(envelope)

    return { pulled, pushed: outgoing.length }
  }

  close(): void {
    this.closed = true
    this.options.doc.off("update", this.updateHandler)
    this.unsubscribe()
  }
}
