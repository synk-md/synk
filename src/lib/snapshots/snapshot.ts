/**
 * Encrypted, signed, hash-linked state sealed under an epoch key.
 *
 * The payload is a merged artifact nobody authored operation by operation -
 * exactly what is disqualified for catch-up. The difference is the producer: an
 * authorised member, signed and attributable, who could already write arbitrary
 * content anyway. A relay serving a synthesised diff could not.
 *
 * So the inputs are verifiable and merge correctness rests on attestation - an
 * accepted residual. The sharp edge is truncation: never drop the envelopes a
 * snapshot covers until its correctness is established to you.
 */

import {
  aeadDecrypt,
  aeadEncrypt,
  fromBase64Url,
  randomNonce,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import type { DeliveryVector } from "@/lib/sync"

export const SNAPSHOT_VERSION = 1

export type SnapshotKind = "join" | "checkpoint" | "automatic" | "promotion"

export interface SnapshotHeader {
  v: typeof SNAPSHOT_VERSION
  /** Key domain this is sealed under - a notebook, or a promoted note. */
  domain: string
  resourceId: string
  kind: SnapshotKind
  /** `did:key` of the producing device. */
  author: string
  /** Epoch whose key seals the payload. */
  epoch: number
  /**
   * The point in the log this covers: highest envelope sequence per author
   * included in the state. Applying the snapshot advances the receiver's
   * delivery vector to here, so they stop asking for envelopes they either
   * already have or could never decrypt.
   */
  covers: DeliveryVector
  /** Previous snapshot's id, forming the hash-linked chain. */
  parent: string | null
  /** SHA-256 of the plaintext state, base64url. */
  stateHash: string
  /** Set on a promotion snapshot - see `promotion.ts`. */
  supersedesNotebookEpoch?: number
  /** User-given name for a pinned checkpoint. */
  label?: string
  createdAt: number
  nonce: string
}

export interface Snapshot extends SnapshotHeader {
  /** base64url AES-256-GCM sealed `Y.encodeStateAsUpdate` output. */
  ct: string
  sig: string
  /** SHA-256 over header and ciphertext. The hash-link anchor. */
  id: string
}

async function sha256(bytes: Bytes): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))
}

/** Canonical header bytes: the AEAD's associated data and the signed prefix. */
export function snapshotHeaderBytes(header: SnapshotHeader): Bytes {
  const covers = Object.keys(header.covers)
    .sort()
    .map((author) => `${author}=${String(header.covers[author])}`)
    .join(",")
  return utf8(
    [
      "synk/snapshot/v1",
      String(header.v),
      header.domain,
      header.resourceId,
      header.kind,
      header.author,
      String(header.epoch),
      covers,
      header.parent ?? "",
      header.stateHash,
      header.supersedesNotebookEpoch === undefined
        ? ""
        : String(header.supersedesNotebookEpoch),
      header.label ?? "",
      String(header.createdAt),
      header.nonce,
    ].join("\n"),
  )
}

export function snapshotSignedBytes(header: SnapshotHeader, ct: string): Bytes {
  return utf8(`${new TextDecoder().decode(snapshotHeaderBytes(header))}\n${ct}`)
}

export interface CreateSnapshotOptions {
  signingKey: SigningKey
  author: string
  domain: string
  resourceId: string
  kind: SnapshotKind
  epoch: number
  dek: Bytes
  /** `Y.encodeStateAsUpdate(doc)` - the full materialised state. */
  state: Bytes
  covers: DeliveryVector
  parent?: string | null
  supersedesNotebookEpoch?: number
  label?: string
  createdAt?: number
  nonce?: Bytes
}

export async function createSnapshot(options: CreateSnapshotOptions): Promise<Snapshot> {
  const nonce = options.nonce ?? randomNonce()
  const header: SnapshotHeader = {
    v: SNAPSHOT_VERSION,
    domain: options.domain,
    resourceId: options.resourceId,
    kind: options.kind,
    author: options.author,
    epoch: options.epoch,
    covers: { ...options.covers },
    parent: options.parent ?? null,
    stateHash: await sha256(options.state),
    createdAt: options.createdAt ?? Date.now(),
    nonce: toBase64Url(nonce),
  }
  if (options.supersedesNotebookEpoch !== undefined) {
    header.supersedesNotebookEpoch = options.supersedesNotebookEpoch
  }
  if (options.label !== undefined) header.label = options.label

  const headerBytes = snapshotHeaderBytes(header)
  const ct = toBase64Url(await aeadEncrypt(options.dek, nonce, options.state, headerBytes))
  const sig = toBase64Url(await options.signingKey.sign(snapshotSignedBytes(header, ct)))
  return { ...header, ct, sig, id: await sha256(utf8(`${toBase64Url(headerBytes)}\n${ct}`)) }
}

export function snapshotHeader(snapshot: Snapshot): SnapshotHeader {
  const header: SnapshotHeader = {
    v: snapshot.v,
    domain: snapshot.domain,
    resourceId: snapshot.resourceId,
    kind: snapshot.kind,
    author: snapshot.author,
    epoch: snapshot.epoch,
    covers: snapshot.covers,
    parent: snapshot.parent,
    stateHash: snapshot.stateHash,
    createdAt: snapshot.createdAt,
    nonce: snapshot.nonce,
  }
  if (snapshot.supersedesNotebookEpoch !== undefined) {
    header.supersedesNotebookEpoch = snapshot.supersedesNotebookEpoch
  }
  if (snapshot.label !== undefined) header.label = snapshot.label
  return header
}

/** Recompute the id. A mismatch means the chain was tampered with. */
export async function snapshotIdOf(snapshot: Snapshot): Promise<string> {
  return sha256(
    utf8(`${toBase64Url(snapshotHeaderBytes(snapshotHeader(snapshot)))}\n${snapshot.ct}`),
  )
}

/**
 * Verify signature and id. Returns false for every rejection - snapshots arrive
 * from the network like anything else.
 *
 * This establishes *who produced it*, not that the merge is correct. Nothing
 * can establish the latter short of replaying the inputs.
 */
export async function verifySnapshot(
  snapshot: Snapshot,
  authorPublicKey: Bytes,
): Promise<boolean> {
  try {
    if (snapshot.v !== SNAPSHOT_VERSION) return false
    if (typeof snapshot.ct !== "string" || typeof snapshot.sig !== "string") return false
    if (fromBase64Url(snapshot.nonce).length !== 12) return false
    if ((await snapshotIdOf(snapshot)) !== snapshot.id) return false
    return await verifySignature(
      authorPublicKey,
      snapshotSignedBytes(snapshotHeader(snapshot), snapshot.ct),
      fromBase64Url(snapshot.sig),
    )
  } catch {
    return false
  }
}

/** Decrypt, and confirm the plaintext is what the producer hashed. */
export async function openSnapshot(snapshot: Snapshot, dek: Bytes): Promise<Bytes> {
  const state = await aeadDecrypt(
    dek,
    fromBase64Url(snapshot.nonce),
    fromBase64Url(snapshot.ct),
    snapshotHeaderBytes(snapshotHeader(snapshot)),
  )
  if ((await sha256(state)) !== snapshot.stateHash) {
    throw new Error("snapshot state does not match its signed hash")
  }
  return state
}

/** Walk a chain by parent pointer, oldest first. Detects breaks and cycles. */
export function chainFrom(
  snapshots: readonly Snapshot[],
  tipId: string,
): { chain: Snapshot[]; complete: boolean } {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
  const chain: Snapshot[] = []
  const seen = new Set<string>()
  let cursor: string | null = tipId

  while (cursor) {
    if (seen.has(cursor)) return { chain: chain.reverse(), complete: false }
    seen.add(cursor)
    const snapshot: Snapshot | undefined = byId.get(cursor)
    if (!snapshot) return { chain: chain.reverse(), complete: false }
    chain.push(snapshot)
    cursor = snapshot.parent
  }
  return { chain: chain.reverse(), complete: true }
}
