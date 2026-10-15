/**
 * What the relay keeps: opaque ciphertext and signed blobs it files but cannot
 * read or alter undetectably.
 *
 * Per-resource logs, not one global log. Response timing over a shared log
 * leaks how busy other tenants are.
 */

import { EnvelopeLog, type DeliveryVector, type Envelope } from "@/lib/sync"
import type { Snapshot } from "@/lib/snapshots"
import type { WorkspaceGenesis } from "@/lib/workspace/genesis"
import { MAX_SLICE_SIZE, type HostedRecord, type HostedSummary, type SliceRequest } from "./protocol"

export interface RelayQuota {
  /** Not enforced: shedding envelopes would lose writing. Pruning is what bounds a log. */
  maxEnvelopesPerResource: number
  maxSnapshotsPerResource: number
  maxRecordsPerWorkspace: number
}

export const DEFAULT_QUOTA: RelayQuota = {
  maxEnvelopesPerResource: 50_000,
  maxSnapshotsPerResource: 64,
  maxRecordsPerWorkspace: 10_000,
}

/**
 * When envelopes may be let go behind an owner's anchor. Age is the relay's own
 * receipt time, not the author's clock, which the relay has no reason to trust.
 */
export interface PrunePolicy {
  /** Only envelopes held at least this long. */
  olderThanMs: number
  /**
   * Only once the owner's claim has stood this long, so an owner who has not
   * opened the notebook since can still dispute a rival who claimed first.
   */
  settleMs: number
}

export const DEFAULT_PRUNE: PrunePolicy = {
  olderThanMs: 30 * 24 * 60 * 60 * 1000,
  settleMs: 7 * 24 * 60 * 60 * 1000,
}

interface OwnerClaim {
  owner: string
  since: number
  /** Two different owners claimed it. Never pruned again. */
  disputed: boolean
}

/** `notebook:<id>` for anything beneath it. */
const governingResource = (resourceId: string) => resourceId.split("/")[0]

const covers = (big: DeliveryVector, small: DeliveryVector) =>
  Object.entries(small).every(([author, seq]) => (big[author] ?? 0) >= seq)

export class RelayStore {
  private readonly logs = new Map<string, EnvelopeLog>()
  private readonly snapshots = new Map<string, Snapshot[]>()
  private readonly records = new Map<string, Map<string, HostedRecord>>()
  private readonly summaries = new Map<string, HostedSummary>()
  private readonly receivedAt = new WeakMap<Envelope, number>()
  private readonly owners = new Map<string, OwnerClaim>()
  /** Snapshots whose signature the server checked, by id. */
  private readonly signed = new Set<string>()
  /** The anchor each resource's floor relies on, kept whatever the quota says. */
  private readonly pinned = new Map<string, string>()
  readonly quota: RelayQuota

  constructor(quota: RelayQuota = DEFAULT_QUOTA) {
    this.quota = quota
  }

  private log(resourceId: string): EnvelopeLog {
    let log = this.logs.get(resourceId)
    if (!log) {
      log = new EnvelopeLog()
      this.logs.set(resourceId, log)
    }
    return log
  }

  /** Returns false when already held, so a duplicate is not fanned out twice. */
  append(envelope: Envelope, now = Date.now()): boolean {
    const fresh = this.log(envelope.resourceId).append(envelope)
    if (fresh) this.receivedAt.set(envelope, now)
    return fresh
  }

  /** How far each author's envelopes were let go for this resource. */
  floor(resourceId: string): DeliveryVector {
    return this.logs.get(resourceId)?.floor() ?? {}
  }

  /** A verified genesis. A second, different owner disputes it for good. */
  claimOwnership(genesis: WorkspaceGenesis, now = Date.now()): OwnerClaim {
    const existing = this.owners.get(genesis.resource)
    if (!existing) {
      const claim = { owner: genesis.owner, since: now, disputed: false }
      this.owners.set(genesis.resource, claim)
      return claim
    }
    if (existing.owner !== genesis.owner) existing.disputed = true
    return existing
  }

  /**
   * Let go of envelopes behind the owner's newest anchor that has aged: one
   * covering what was let go before, with everything it adds held here and
   * old enough. Exactly to its coverage, never partway, so the floor is
   * always where an anchor is - and a point just after it can be rebuilt.
   * Returns how many went.
   */
  prune(resourceId: string, now: number, policy: PrunePolicy = DEFAULT_PRUNE): number {
    const log = this.logs.get(resourceId)
    const claim = this.owners.get(governingResource(resourceId))
    if (!log || !claim || claim.disputed || now - claim.since < policy.settleMs) return 0

    const floor = log.floor()
    const aged = (snapshot: Snapshot) =>
      Object.entries(snapshot.covers).every(([author, covered]) => {
        for (let seq = (floor[author] ?? 0) + 1; seq <= covered; seq += 1) {
          const envelope = log.get(author, seq)
          const at = envelope ? this.receivedAt.get(envelope) : undefined
          if (at === undefined || now - at < policy.olderThanMs) return false
        }
        return true
      })
    const anchor = this.archived(resourceId)
      .filter((snapshot) => snapshot.author === claim.owner && this.signed.has(snapshot.id))
      .filter((snapshot) => covers(snapshot.covers, floor) && !covers(floor, snapshot.covers))
      .sort((a, b) => b.createdAt - a.createdAt)
      .find(aged)
    if (!anchor) return 0
    this.pinned.set(resourceId, anchor.id)
    return log.prune(anchor.covers)
  }

  get resourceIds(): string[] {
    return [...this.logs.keys()]
  }

  since(resourceId: string, vector: DeliveryVector): Envelope[] {
    return this.log(resourceId).selectSince(vector)
  }

  vector(resourceId: string): DeliveryVector {
    return this.log(resourceId).deliveryVector()
  }

  /** A bounded window. The cap is server-side; a client may ask for more. */
  slice(request: SliceRequest): { envelopes: Envelope[]; complete: boolean } {
    const log = this.logs.get(request.resourceId)
    if (!log) return { envelopes: [], complete: true }

    const from = Math.max(0, Math.floor(request.fromSeq))
    const to = Math.max(from, Math.floor(request.toSeq))

    const out: Envelope[] = []
    const authors = request.author
      ? [request.author]
      : [...new Set(log.all().map((envelope) => envelope.author))].sort()

    let truncated = false
    for (const author of authors) {
      for (let seq = from + 1; seq <= to; seq += 1) {
        const envelope = log.get(author, seq)
        if (!envelope) continue
        if (out.length >= MAX_SLICE_SIZE) {
          truncated = true
          break
        }
        out.push(envelope)
      }
      if (truncated) break
    }
    return { envelopes: out, complete: !truncated }
  }

  /** `signed` when the server checked its signature, which makes it an anchor candidate. */
  archive(snapshot: Snapshot, options: { signed?: boolean } = {}): void {
    const held = this.snapshots.get(snapshot.resourceId) ?? []
    if (held.some((existing) => existing.id === snapshot.id)) return
    if (options.signed) this.signed.add(snapshot.id)
    const next = [...held, snapshot]
    // Oldest out first: the chain is hash-linked, so a later snapshot already
    // covers what the tail held. A checkpoint someone named goes last - it was
    // kept on purpose, and an automatic point is only ever a convenience. The
    // anchor a floor relies on never goes: it holds what was let go.
    const pinned = this.pinned.get(snapshot.resourceId)
    while (next.length > this.quota.maxSnapshotsPerResource) {
      const shed = (entry: Snapshot, onlyAutomatic: boolean) =>
        entry.id !== pinned && (!onlyAutomatic || entry.kind !== "checkpoint")
      const automatic = next.findIndex((entry) => shed(entry, true))
      const any = next.findIndex((entry) => shed(entry, false))
      const index = automatic >= 0 ? automatic : any
      if (index < 0) break
      const [gone] = next.splice(index, 1)
      this.signed.delete(gone.id)
    }
    this.snapshots.set(snapshot.resourceId, next)
  }

  archived(resourceId: string): Snapshot[] {
    return [...(this.snapshots.get(resourceId) ?? [])]
  }

  putRecords(records: readonly HostedRecord[]): number {
    let stored = 0
    for (const record of records) {
      let bucket = this.records.get(record.workspace)
      if (!bucket) {
        bucket = new Map()
        this.records.set(record.workspace, bucket)
      }
      if (bucket.size >= this.quota.maxRecordsPerWorkspace && !bucket.has(record.id)) continue
      const existing = bucket.get(record.id)
      // The relay cannot tell a rollback from a retry, but there is no reason
      // to serve the older one.
      if (existing && existing.updatedAt > record.updatedAt) continue
      bucket.set(record.id, record)
      stored += 1
    }
    return stored
  }

  getRecords(workspace: string, kind?: HostedRecord["kind"]): HostedRecord[] {
    const bucket = this.records.get(workspace)
    if (!bucket) return []
    const all = [...bucket.values()]
    return kind ? all.filter((record) => record.kind === kind) : all
  }

  putSummary(summary: HostedSummary): void {
    this.summaries.set(summary.workspace, summary)
  }

  getSummary(workspace: string): HostedSummary | undefined {
    return this.summaries.get(workspace)
  }

  get resourceCount(): number {
    return this.logs.size
  }

  envelopeCount(resourceId: string): number {
    return this.logs.get(resourceId)?.size ?? 0
  }
}
