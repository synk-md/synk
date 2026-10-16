/**
 * The relay wire protocol. Trusted for liveness only.
 *
 * No message lets the server assert that anything is valid - it forwards or it
 * does not. There is no field a client could read instead of verifying, and so
 * none for a hostile server to lie in.
 */

import type { Envelope } from "@/lib/sync"
import type { DeliveryVector } from "@/lib/sync"
import type { Snapshot } from "@/lib/snapshots"
import type { WorkspaceGenesis } from "@/lib/workspace/genesis"
import type { Standby, Succession } from "@/lib/workspace/succession"

export const RELAY_PROTOCOL_VERSION = 1

/** Ceiling on one slice request, so a client cannot ask for the whole archive. */
export const MAX_SLICE_SIZE = 500

export type RelayErrorCode =
  | "unsupported-version"
  | "not-authenticated"
  | "bad-signature"
  | "rate-limited"
  | "not-subscribed"
  | "unknown-resource"
  | "malformed"
  | "quota-exceeded"
  | "unavailable"

/** A signed blob the relay files but never interprets. */
export interface HostedRecord {
  kind: "directory" | "prekey" | "revocation" | "epoch" | "capability"
  id: string
  workspace: string
  blob: string
  updatedAt: number
}

/** Clients verify the signature before trusting it. */
export interface HostedSummary {
  workspace: string
  /** The freshness summary, as produced by M8. Opaque here. */
  blob: string
}

export interface SliceRequest {
  resourceId: string
  /** Restrict to one author, which is how a client fills a known gap. */
  author?: string
  /** Exclusive lower bound, inclusive upper. */
  fromSeq: number
  toSeq: number
}

/* ---- client to server ---------------------------------------------------- */

export type ClientMessage =
  | { op: "hello"; id: string; v: number }
  | { op: "auth"; id: string; did: string; sig: string }
  | { op: "subscribe"; id: string; resources: string[] }
  | { op: "publish"; id: string; envelope: Envelope }
  | { op: "since"; id: string; resourceId: string; vector: DeliveryVector }
  | { op: "vector"; id: string; resourceId: string }
  /** How far envelopes were let go, so a device behind it knows to start from an anchor. */
  | { op: "floor"; id: string; resourceId: string }
  /**
   * The owner's genesis, which is what lets the relay prune behind their
   * anchors, and the owner's own linked devices, whose anchors count too.
   * Sent by the owner's device, so the list is the owner's word; each claim
   * replaces the last.
   */
  | {
      op: "claim-owner"
      id: string
      genesis: WorkspaceGenesis
      deputies?: string[]
      /** The hand-overs since the genesis, when the claimant took over. */
      standbys?: Standby[]
      successions?: Succession[]
    }
  | { op: "deposit-snapshot"; id: string; snapshot: Snapshot }
  | { op: "snapshots"; id: string; resourceId: string }
  | { op: "slice"; id: string; request: SliceRequest }
  | { op: "records-get"; id: string; workspace: string; kind?: HostedRecord["kind"] }
  | { op: "records-put"; id: string; records: HostedRecord[] }
  | { op: "freshness"; id: string; workspace: string }
  | { op: "signal"; id: string; to: string; payload: string }
  | { op: "turn"; id: string }

/* ---- server to client ---------------------------------------------------- */

export interface TurnCredentials {
  urls: string[]
  username: string
  credential: string
  expiresAt: number
}

export type ServerReply =
  | { id: string; ok: true; re: "hello"; v: number; challenge: string }
  | { id: string; ok: true; re: "auth"; session: string; limits: { maxSlice: number } }
  | { id: string; ok: true; re: "subscribe"; resources: string[] }
  | { id: string; ok: true; re: "publish" }
  | { id: string; ok: true; re: "since"; envelopes: Envelope[] }
  | { id: string; ok: true; re: "vector"; vector: DeliveryVector }
  | { id: string; ok: true; re: "floor"; floor: DeliveryVector }
  | { id: string; ok: true; re: "claim-owner" }
  | { id: string; ok: true; re: "deposit-snapshot" }
  | { id: string; ok: true; re: "snapshots"; snapshots: Snapshot[] }
  | { id: string; ok: true; re: "slice"; envelopes: Envelope[]; complete: boolean }
  | { id: string; ok: true; re: "records-get"; records: HostedRecord[] }
  | { id: string; ok: true; re: "records-put"; stored: number }
  | { id: string; ok: true; re: "freshness"; summary: HostedSummary | null }
  | { id: string; ok: true; re: "signal" }
  | { id: string; ok: true; re: "turn"; credentials: TurnCredentials }
  | { id: string; ok: false; error: RelayErrorCode; detail?: string }

/** Unsolicited. Nothing here asserts validity. */
export type ServerPush =
  | { push: "envelope"; envelope: Envelope }
  | { push: "freshness"; summary: HostedSummary }
  | { push: "signal"; from: string; payload: string }

export type ServerMessage = ServerReply | ServerPush

export function isPush(message: ServerMessage): message is ServerPush {
  return "push" in message
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message)
}

/** Undefined rather than throwing: a bad frame is an event to count. */
export function decode<T>(frame: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(frame)
    if (typeof parsed !== "object" || parsed === null) return undefined
    return parsed as T
  } catch {
    return undefined
  }
}

let counter = 0
export function nextRequestId(): string {
  counter += 1
  return `${String(Date.now().toString(36))}-${String(counter)}`
}
