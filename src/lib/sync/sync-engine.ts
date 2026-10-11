/**
 * The interposition point: the Yjs update boundary. Outbound, encrypt, sign,
 * log, publish. Inbound, verify, authorise, dedup, decrypt, check for client-id
 * forgery, then apply with a REMOTE origin.
 *
 * The update event cannot await, so the handler does the one synchronous thing
 * - claiming the sequence number - and queues the crypto behind it.
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
import { openSnapshotWith, type Snapshot } from "@/lib/snapshots/snapshot"

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

/** Undefined rejects the envelope. Normally backed by the verified directory. */
export interface AuthorResolver {
  resolve(did: string): Promise<AuthorInfo | undefined>
}

/** Whether an author may write here. Implemented by the capability chain. */
export interface WritePolicy {
  canWrite(resourceId: string, authorDid: string): Promise<boolean> | boolean
}

/** Supplies content keys. */
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

/** Where this device's own authoring stands for one resource. */
export interface SyncCursor {
  /** Highest sequence number handed out. Never reused. */
  seq: number
  /** This device's own Yjs clock when that number was handed out. */
  clock: number
}

/**
 * Persists the cursor across reloads.
 *
 * Without it a reload restarts at seq 1, and the relay and every peer answer a
 * duplicate (author, seq) with success and keep the old one - so every edit
 * after the reload looks published and reaches nobody.
 */
export interface SyncCursorStore {
  load(): SyncCursor
  save(cursor: SyncCursor): void
}

export function memoryCursorStore(): SyncCursorStore {
  let cursor: SyncCursor = { seq: 0, clock: 0 }
  return {
    load: () => cursor,
    save: (next) => {
      cursor = next
    },
  }
}

export interface ResumeResult {
  /** Sequence numbers the relay lacked and nothing here could resend. */
  filled: number
  /** Whether this device's own content was published again. */
  republished: boolean
}

/** A valid update containing nothing: fills a sequence number without content. */
const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc())

function ownClock(doc: Y.Doc, clientId: number): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(clientId) ?? 0
}

/** This client's own operations past `since`, and nobody else's. */
function ownUpdateSince(doc: Y.Doc, clientId: number, since: number): Uint8Array {
  const target = Y.decodeStateVector(Y.encodeStateVector(doc))
  target.set(clientId, since)
  return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(target))
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
  /** Defaults to memory, which is only correct for a document that never reloads. */
  cursor?: SyncCursorStore
  /**
   * Whether every operation must carry its author's derived client id. Off
   * only for documents whose records carry their own signatures, where who
   * typed an operation means nothing and a pinned id would need a writer lock.
   */
  attributeOperations?: boolean
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
  /** Serialised so check-then-append is atomic across concurrent receives. */
  private inbound: Promise<void> = Promise.resolve()
  private localSeq = 0
  /** Own clock as of `localSeq`. */
  private localClock = 0
  private readonly cursor: SyncCursorStore
  private closed = false

  constructor(options: SyncEngineOptions) {
    this.options = options
    this.cursor = options.cursor ?? memoryCursorStore()
    const saved = this.cursor.load()
    this.localSeq = saved.seq
    this.localClock = saved.clock

    this.updateHandler = (update, origin, _doc, transaction) => {
      // Loop guard, on the origin rather than content: a remote update can be
      // byte-identical to something we would author.
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

  /**
   * Yjs reassigns `clientID` when it sees what looks like a collision, and a
   * reassigned document authors operations no peer will accept - the
   * attribution check rejects them remotely, so the writer sees nothing at
   * all. Failing loudly here beats publishing into a void.
   */
  private mayAuthor(): boolean {
    if (this.options.attributeOperations === false) return true
    if (this.options.doc.clientID === this.options.clientId) return true
    this.options.onError?.(
      new Error(
        `refusing to publish: document client id is ${String(this.options.doc.clientID)} ` +
          `but this device may only author as ${String(this.options.clientId)}`,
      ),
    )
    return false
  }

  /**
   * Hand out the next number, persisted before any envelope exists. A number
   * lost to a crash is a gap, which `resume` fills; a number reused is an edit
   * every peer drops as a duplicate, which nothing can recover.
   */
  private reserve(): number {
    // Re-read rather than trusted from memory: another tab on this device may
    // have been the writer since this engine loaded it.
    const stored = this.cursor.load()
    if (stored.seq > this.localSeq) {
      this.localSeq = stored.seq
      this.localClock = stored.clock
    }
    const seq = ++this.localSeq
    this.localClock = ownClock(this.options.doc, this.options.clientId)
    this.cursor.save({ seq, clock: this.localClock })
    return seq
  }

  private async seal(seq: number, update: Uint8Array): Promise<Envelope> {
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
    return envelope
  }

  private enqueueOutbound(update: Uint8Array): void {
    if (!this.mayAuthor()) return
    const seq = this.reserve() // synchronous: pins this edit's place in order
    this.outbound = this.outbound
      .then(async () => {
        if (this.closed) return
        await this.seal(seq, update)
      })
      .catch((error: unknown) => {
        this.options.onError?.(error)
      })
  }

  /**
   * Put right whatever an earlier session left undelivered. Run on start and
   * whenever the relay comes back.
   *
   * Three things can be wrong, and each has one remedy:
   *
   *   the relay has seen higher numbers than this device remembers
   *     (site data cleared) - skip past them, never reuse one
   *   numbers were handed out that the relay never received (a publish lost
   *     to an outage, then the tab closed) - fill each so catch-up is not
   *     stuck behind the gap, and republish all own content, since which
   *     edits were lost is unknowable
   *   own operations exist that never had a number at all (written before
   *     any engine was attached) - publish them
   *
   * All of it is idempotent for receivers, so a wrong guess costs bandwidth,
   * not content.
   */
  async resume(): Promise<ResumeResult> {
    const result: ResumeResult = { filled: 0, republished: false }
    // Captured now: edits made while this runs get later numbers and their own
    // envelopes, and must not be mistaken for a gap.
    const reserved = this.localSeq
    const reservedClock = this.localClock

    const step = this.outbound.then(async () => {
      if (this.closed || !this.mayAuthor()) return
      const author = this.options.author
      const theirs = await this.options.transport.vector()
      const relayHas = theirs[author] ?? 0

      if (relayHas > this.localSeq) {
        this.localSeq = relayHas
        this.cursor.save({ seq: this.localSeq, clock: this.localClock })
      }

      let lost = false
      for (let seq = relayHas + 1; seq <= reserved; seq += 1) {
        const held = this.log.get(author, seq)
        if (held) {
          await this.options.transport.publish(held)
          continue
        }
        lost = true
        await this.seal(seq, EMPTY_UPDATE)
        result.filled += 1
      }

      const clock = ownClock(this.options.doc, this.options.clientId)
      const since = lost ? 0 : reservedClock
      if (clock > since) {
        await this.seal(this.reserve(), ownUpdateSince(this.options.doc, this.options.clientId, since))
        result.republished = true
      }
    })
    this.outbound = step.catch((error: unknown) => {
      this.options.onError?.(error)
    })
    await step
    return result
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
   * Publish the whole document as one envelope.
   *
   * For small documents synced without per-device cursors: whatever an earlier
   * session failed to deliver is in here, sealed under the current epoch, so a
   * member who joined since can read all of it.
   */
  async publishState(): Promise<boolean> {
    if (Y.encodeStateVector(this.options.doc).length <= 1) return false
    const step = this.outbound.then(async () => {
      if (this.closed || !this.mayAuthor()) return false
      await this.seal(this.reserve(), Y.encodeStateAsUpdate(this.options.doc))
      return true
    })
    this.outbound = step.then(
      () => undefined,
      (error: unknown) => {
        this.options.onError?.(error)
      },
    )
    return step
  }

  /** Outbound first, then inbound, then outbound again for what it scheduled. */
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
   * Order is the security property: nothing attacker-supplied is decrypted
   * before it is both authentic and authorised.
   */
  async receive(envelope: Envelope): Promise<boolean> {
    if (this.closed) return false
    if (!isEnvelopeShaped(envelope)) return this.reject("malformed")
    // A presence envelope is well formed and unhandled here, so it is counted
    // separately rather than dropped as malformed.
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

    // Attribution integrity: operations claiming another author's client id.
    if (this.options.attributeOperations !== false && !checkUpdateAuthorship(update, author.clientId).ok)
      return this.reject("forged-client-id")

    // Stored before applying, so a peer can serve it on even if apply throws.
    this.log.append(envelope)
    Y.applyUpdate(this.options.doc, update, REMOTE_ORIGIN)
    this.stats.applied += 1
    return true
  }

  deliveryVector(): DeliveryVector {
    return this.log.deliveryVector()
  }

/**
   * The one place a merged, unauthored artifact is accepted - and only from an
   * author already authorised to write here, who could put arbitrary content in
   * the document anyway. The client-id check deliberately does not apply: a
   * snapshot contains every author's operations by construction.
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

    // Which epochs can open this is decided by its wraps, not by the epoch it
    // was created under: a snapshot re-sealed for a new member is reachable
    // under theirs without having been rebuilt.
    let state: Bytes | undefined
    try {
      state = await openSnapshotWith(snapshot, {
        keyFor: (epoch) => this.options.keys.forEpoch(epoch),
        readableEpochs: () => snapshot.wraps.map((wrap) => wrap.epoch),
      })
    } catch {
      return this.reject("undecryptable")
    }
    if (!state) return this.reject("unknown-epoch")

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
   * Catch-up both ways: pull originals verified individually, push whatever the
   * responder is missing. Pulling alone strands a peer that authored offline.
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
