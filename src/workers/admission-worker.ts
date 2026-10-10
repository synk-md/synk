/// <reference lib="webworker" />

/**
 * Sealing and signing a note's baseline, off the main thread.
 *
 * What is here is the part that costs CPU: AES-GCM over a document's whole
 * state, a SHA-256 of it, and an Ed25519 signature, once per note. On a large
 * notebook that is the only work in admission that would visibly stall a tab.
 *
 * What is *not* here, deliberately:
 *
 *   the plan        persisted in localStorage, which a worker cannot reach, so
 *                   resumability stays where the storage is
 *   loading notes   IndexedDB reads are I/O rather than CPU, and the main
 *                   thread already caches the documents
 *   depositing      the relay connection lives on the main thread, and a
 *                   second one would mean a second handshake
 *
 * So the worker is handed a document's state and hands back a snapshot. The
 * epoch key crosses with it, which is the same origin and the same process
 * boundary the main thread already trusts.
 */

import { restoreSigningKey, type StorableSigningKey } from "@/lib/crypto"
import { createSnapshot, rewrapSnapshot, type Snapshot } from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"

export interface SealRequest {
  kind: "seal"
  id: number
  storedKey: StorableSigningKey
  author: string
  domain: string
  resourceId: string
  epoch: number
  epochKey: Uint8Array
  /** `Y.encodeStateAsUpdate` output, produced on the main thread. */
  state: Uint8Array
  covers: DeliveryVector
  createdAt: number
}

export interface RewrapRequest {
  kind: "rewrap"
  id: number
  storedKey: StorableSigningKey
  author: string
  snapshot: Snapshot
  fromEpochKey: Uint8Array
  toEpoch: number
  toEpochKey: Uint8Array
  createdAt: number
}

export type AdmissionRequest = SealRequest | RewrapRequest

export type AdmissionResponse =
  | { id: number; ok: true; snapshot: Snapshot }
  | { id: number; ok: false; error: string }

async function handle(request: AdmissionRequest): Promise<Snapshot> {
  const signingKey = await restoreSigningKey(request.storedKey)

  if (request.kind === "rewrap") {
    return rewrapSnapshot(request.snapshot, {
      fromEpochKey: request.fromEpochKey,
      toEpoch: request.toEpoch,
      toEpochKey: request.toEpochKey,
      signingKey,
      wrapper: request.author,
      createdAt: request.createdAt,
    })
  }

  return createSnapshot({
    signingKey,
    author: request.author,
    domain: request.domain,
    resourceId: request.resourceId,
    kind: "join",
    epoch: request.epoch,
    dek: request.epochKey,
    state: request.state,
    covers: request.covers,
    parent: null,
    createdAt: request.createdAt,
  })
}

self.onmessage = (event: MessageEvent<AdmissionRequest>) => {
  const request = event.data
  void handle(request)
    .then((snapshot) => {
      const response: AdmissionResponse = { id: request.id, ok: true, snapshot }
      self.postMessage(response)
    })
    .catch((error: unknown) => {
      const response: AdmissionResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "sealing failed",
      }
      self.postMessage(response)
    })
}
