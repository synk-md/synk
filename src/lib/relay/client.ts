/**
 * A relay client pinned to one resource.
 *
 * A thin view over `RelayConnection`, which owns the socket, the handshake and
 * the request plumbing. Keeping one copy of that matters more than the small
 * indirection: it is where correlation, reconnection and re-subscription bugs
 * live, and two copies would drift.
 *
 * Implements `Transport`, so nothing above it knows whether the bytes went
 * through a paid server or straight to another browser.
 */

import type { Snapshot } from "@/lib/snapshots"
import type { DeliveryVector, Envelope, Transport } from "@/lib/sync"

import {
  RelayConnection as Connection,
  type RelayConnectionOptions,
  type RelayConnectionState,
} from "./connection"
import type { HostedRecord, HostedSummary, SliceRequest, TurnCredentials } from "./protocol"

export interface RelayClientOptions extends RelayConnectionOptions {
  resourceId: string
}

export class RelayClient implements Transport {
  readonly name = "relay"

  private readonly connection: Connection
  private readonly transport: Transport

  constructor(options: RelayClientOptions) {
    const { resourceId, ...rest } = options
    this.connection = new Connection(rest)
    this.transport = this.connection.transportFor(resourceId)
  }

  get state(): RelayConnectionState {
    return this.connection.state
  }

  publish(envelope: Envelope): Promise<void> {
    return this.transport.publish(envelope)
  }

  subscribe(handler: (envelope: Envelope) => void): () => void {
    return this.transport.subscribe(handler)
  }

  fetchSince(vector: DeliveryVector): Promise<Envelope[]> {
    return this.transport.fetchSince(vector)
  }

  vector(): Promise<DeliveryVector> {
    return this.transport.vector()
  }

  floor(): Promise<DeliveryVector> {
    return this.transport.floor?.() ?? Promise.resolve({})
  }

  depositSnapshot(snapshot: Snapshot): Promise<void> {
    return this.transport.depositSnapshot(snapshot)
  }

  fetchSnapshots(resourceId: string): Promise<Snapshot[]> {
    return this.transport.fetchSnapshots(resourceId)
  }

  fetchSlice(request: SliceRequest): Promise<{ envelopes: Envelope[]; complete: boolean }> {
    return this.connection.fetchSlice(request)
  }

  getRecords(workspace: string, kind?: HostedRecord["kind"]): Promise<HostedRecord[]> {
    return this.connection.getRecords(workspace, kind)
  }

  putRecords(records: readonly HostedRecord[]): Promise<number> {
    return this.connection.putRecords(records)
  }

  fetchFreshness(workspace: string): Promise<HostedSummary | null> {
    return this.connection.fetchFreshness(workspace)
  }

  sendSignal(to: string, payload: string): Promise<boolean> {
    return this.connection.sendSignal(to, payload)
  }

  turnCredentials(): Promise<TurnCredentials | undefined> {
    return this.connection.turnCredentials()
  }

  close(): void {
    this.connection.close()
  }
}
