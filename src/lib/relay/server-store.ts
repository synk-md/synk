/**
 * What the relay keeps: opaque ciphertext and signed blobs it files but cannot
 * read or alter undetectably.
 *
 * Per-resource logs, not one global log. Response timing over a shared log
 * leaks how busy other tenants are.
 */

import { EnvelopeLog, type DeliveryVector, type Envelope } from "@/lib/sync"
import type { Snapshot } from "@/lib/snapshots"
import { MAX_SLICE_SIZE, type HostedRecord, type HostedSummary, type SliceRequest } from "./protocol"

export interface RelayQuota {
  /** Envelopes retained per resource before the oldest are shed. */
  maxEnvelopesPerResource: number
  maxSnapshotsPerResource: number
  maxRecordsPerWorkspace: number
}

export const DEFAULT_QUOTA: RelayQuota = {
  maxEnvelopesPerResource: 50_000,
  maxSnapshotsPerResource: 64,
  maxRecordsPerWorkspace: 10_000,
}

export class RelayStore {
  private readonly logs = new Map<string, EnvelopeLog>()
  private readonly snapshots = new Map<string, Snapshot[]>()
  private readonly records = new Map<string, Map<string, HostedRecord>>()
  private readonly summaries = new Map<string, HostedSummary>()
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
  append(envelope: Envelope): boolean {
    return this.log(envelope.resourceId).append(envelope)
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

  archive(snapshot: Snapshot): void {
    const held = this.snapshots.get(snapshot.resourceId) ?? []
    if (held.some((existing) => existing.id === snapshot.id)) return
    const next = [...held, snapshot]
    // Oldest out first: the chain is hash-linked, so a later snapshot already
    // covers what the tail held. A checkpoint someone named goes last - it was
    // kept on purpose, and an automatic point is only ever a convenience.
    while (next.length > this.quota.maxSnapshotsPerResource) {
      const automatic = next.findIndex((entry) => entry.kind !== "checkpoint")
      next.splice(automatic >= 0 ? automatic : 0, 1)
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
