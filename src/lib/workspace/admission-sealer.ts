/**
 * Sealing baselines, in a worker when there is one.
 *
 * Falls back to doing it in place. A missing `Worker` - an old browser, a test
 * environment, a context that forbids them - should make admission slower, not
 * impossible, and the fallback runs exactly the same functions.
 */

import type { SigningKey, StorableSigningKey } from "@/lib/crypto"
import { createSnapshot, rewrapSnapshot, type Snapshot } from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"

import type { AdmissionRequest, AdmissionResponse } from "@/workers/admission-worker"

export interface SealNoteOptions {
  domain: string
  resourceId: string
  epoch: number
  epochKey: Uint8Array
  state: Uint8Array
  covers: DeliveryVector
  createdAt: number
}

export interface RewrapNoteOptions {
  snapshot: Snapshot
  fromEpochKey: Uint8Array
  toEpoch: number
  toEpochKey: Uint8Array
  createdAt: number
}

export interface Sealer {
  seal(options: SealNoteOptions): Promise<Snapshot>
  rewrap(options: RewrapNoteOptions): Promise<Snapshot>
  /** True when the work is actually leaving the main thread. */
  readonly offThread: boolean
  close(): void
}

/** Runs in place. The fallback, and what tests use. */
export function inlineSealer(signingKey: SigningKey, author: string): Sealer {
  return {
    offThread: false,
    seal: (options) =>
      createSnapshot({
        signingKey,
        author,
        domain: options.domain,
        resourceId: options.resourceId,
        kind: "join",
        epoch: options.epoch,
        dek: options.epochKey,
        state: options.state,
        covers: options.covers,
        parent: null,
        createdAt: options.createdAt,
      }),
    rewrap: (options) =>
      rewrapSnapshot(options.snapshot, {
        fromEpochKey: options.fromEpochKey,
        toEpoch: options.toEpoch,
        toEpochKey: options.toEpochKey,
        signingKey,
        wrapper: author,
        createdAt: options.createdAt,
      }),
    close: () => undefined,
  }
}

/** Distributive: `Omit` over a union keeps only the keys every member shares. */
type WithoutId = AdmissionRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never

interface Waiting {
  resolve: (snapshot: Snapshot) => void
  reject: (error: Error) => void
}

/**
 * Hands each note to a worker.
 *
 * The signing key crosses as a `StorableSigningKey`, which is what the key
 * store already persists - so this needs no new way of moving key material,
 * and a non-extractable key stays non-extractable on the other side.
 */
export function workerSealer(
  storedKey: StorableSigningKey,
  author: string,
): Sealer | null {
  if (typeof Worker === "undefined") return null

  let worker: Worker
  try {
    worker = new Worker(new URL("@/workers/admission-worker.ts", import.meta.url), {
      type: "module",
    })
  } catch {
    return null
  }

  const waiting = new Map<number, Waiting>()
  let next = 0

  worker.onmessage = (event: MessageEvent<AdmissionResponse>) => {
    const response = event.data
    const pending = waiting.get(response.id)
    if (!pending) return
    waiting.delete(response.id)
    if (response.ok) pending.resolve(response.snapshot)
    else pending.reject(new Error(response.error))
  }
  worker.onerror = () => {
    // One failure takes the worker down for good, so everything in flight is
    // failed rather than left hanging - the plan retries them.
    for (const [, pending] of waiting) pending.reject(new Error("sealing worker failed"))
    waiting.clear()
  }

  const send = (request: WithoutId): Promise<Snapshot> => {
    const id = (next += 1)
    return new Promise<Snapshot>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      worker.postMessage({ ...request, id } as AdmissionRequest)
    })
  }

  return {
    offThread: true,
    seal: (options) =>
      send({
        kind: "seal",
        storedKey,
        author,
        domain: options.domain,
        resourceId: options.resourceId,
        epoch: options.epoch,
        epochKey: options.epochKey,
        state: options.state,
        covers: options.covers,
        createdAt: options.createdAt,
      }),
    rewrap: (options) =>
      send({
        kind: "rewrap",
        storedKey,
        author,
        snapshot: options.snapshot,
        fromEpochKey: options.fromEpochKey,
        toEpoch: options.toEpoch,
        toEpochKey: options.toEpochKey,
        createdAt: options.createdAt,
      }),
    close: () => {
      worker.terminate()
      for (const [, pending] of waiting) pending.reject(new Error("sealing worker closed"))
      waiting.clear()
    },
  }
}

/** A worker when possible, in place otherwise. */
export function createSealer(
  signingKey: SigningKey,
  author: string,
): Sealer {
  return workerSealer(signingKey.toStorable(), author) ?? inlineSealer(signingKey, author)
}
