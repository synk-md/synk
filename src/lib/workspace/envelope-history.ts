/**
 * A shared note's history, read from its envelopes.
 *
 * Every envelope is already a signed, dated, attributed change. Grouped into
 * sessions - one person writing, until someone else does or they pause - they
 * are the timeline, credited to whoever actually wrote them rather than to
 * whichever device happened to take a snapshot. Listing them needs only the
 * headers; nothing is decrypted until a point is opened.
 *
 * A point is rebuilt from the newest anchor snapshot it comes after, plus the
 * envelopes after that anchor up to the session's end. Anchors are what keep
 * that bounded: checkpoints someone named, the snapshots taken when someone
 * joins, and sparse automatic ones.
 *
 * Replay checks what history needs and not what live sync does. An envelope
 * must verify against its author's own key, carry only that author's client
 * id, and open under a key this device holds - which nobody outside the
 * notebook ever had. It is not required to be from someone who is a member
 * now: a removed member's writing was real, and history should still show it.
 */

import * as Y from "yjs"

import { toBase64Url, type Bytes } from "@/lib/crypto"
import { deriveClientId, publicKeyFromDid } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { openSnapshotWith, verifySnapshot, type Snapshot } from "@/lib/snapshots"
import {
  checkUpdateAuthorship,
  laneOwner,
  openEnvelope,
  verifyEnvelopeSignature,
  type DeliveryVector,
  type Envelope,
} from "@/lib/sync"

/** A pause this long starts a new session, even for the same person. */
export const SESSION_PAUSE_MS = 5 * 60 * 1000

export interface Session {
  /** Stable for the same envelopes. */
  id: string
  /** The writing device. */
  author: string
  from: number
  to: number
  changes: number
  epochs: number[]
  /** Where the note stood when it ended: every author's writing up to then. */
  end: DeliveryVector
}

type Dated = Envelope & { createdAt: number }

const dated = (envelope: Envelope): envelope is Dated => typeof envelope.createdAt === "number"

/**
 * Sessions, oldest first. Envelopes from before they carried a time have no
 * place on a timeline; what they wrote is in the anchors that came after.
 */
export function sessionsOf(envelopes: readonly Envelope[], options: { pauseMs?: number } = {}): Session[] {
  const pause = options.pauseMs ?? SESSION_PAUSE_MS
  const ordered = envelopes
    .filter(dated)
    .sort((a, b) => a.createdAt - b.createdAt || (a.author < b.author ? -1 : 1) || a.seq - b.seq)

  const sessions: Session[] = []
  const reached: DeliveryVector = {}
  let current: { author: string; first: Dated; last: Dated; changes: number; epochs: Set<number> } | null = null

  const close = () => {
    if (!current) return
    sessions.push({
      id: `${current.author}:${String(current.first.seq)}-${String(current.last.seq)}`,
      author: current.author,
      from: current.first.createdAt,
      to: current.last.createdAt,
      changes: current.changes,
      epochs: [...current.epochs].sort((a, b) => a - b),
      end: { ...reached },
    })
  }

  for (const envelope of ordered) {
    const author = laneOwner(envelope.author)
    if (current && (current.author !== author || envelope.createdAt - current.last.createdAt > pause)) {
      close()
      current = null
    }
    current ??= { author, first: envelope, last: envelope, changes: 0, epochs: new Set() }
    current.last = envelope
    current.changes += 1
    current.epochs.add(envelope.epoch)
    reached[envelope.author] = Math.max(reached[envelope.author] ?? 0, envelope.seq)
  }
  close()
  return sessions
}

export interface RebuiltState {
  state: Bytes
  /** False when something it should contain could not be opened here. */
  complete: boolean
}

const covered = (vector: DeliveryVector, cut: DeliveryVector) =>
  Object.entries(vector).every(([author, seq]) => seq <= (cut[author] ?? 0))

/** The note as it stood at `cut`: the newest anchor before it, then the envelopes after that. */
export async function stateAt(options: {
  cut: DeliveryVector
  anchors: readonly Snapshot[]
  envelopes: readonly Envelope[]
  keys: Pick<ReadKeySource, "keyFor" | "readableEpochs">
}): Promise<RebuiltState> {
  const readable = new Set(options.keys.readableEpochs())
  const doc = new Y.Doc()
  let complete = true
  let base: DeliveryVector = {}

  const anchor = [...options.anchors]
    .filter((snapshot) => covered(snapshot.covers, options.cut))
    .filter((snapshot) => snapshot.wraps.some((wrap) => readable.has(wrap.epoch)))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (anchor && (await verifySnapshot(anchor, publicKeyFromDid(anchor.author, "ed25519")))) {
    const state = await openSnapshotWith(anchor, {
      keyFor: (epoch) => options.keys.keyFor(epoch),
      readableEpochs: () => anchor.wraps.map((wrap) => wrap.epoch),
    })
    if (state) {
      Y.applyUpdate(doc, state)
      base = anchor.covers
    }
  }

  const replay = options.envelopes
    .filter((envelope) => envelope.seq > (base[envelope.author] ?? 0))
    .filter((envelope) => envelope.seq <= (options.cut[envelope.author] ?? 0))
    .sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : a.seq - b.seq))

  for (const envelope of replay) {
    const owner = laneOwner(envelope.author)
    const publicKey = publicKeyFromDid(owner, "ed25519")
    const key = await options.keys.keyFor(envelope.epoch)
    if (!key || !(await verifyEnvelopeSignature(envelope, publicKey))) {
      complete = false
      continue
    }
    let update: Bytes
    try {
      update = await openEnvelope(envelope, key)
    } catch {
      complete = false
      continue
    }
    // Lanes write documents whose operations are not attributed, so only a
    // device writing as itself is held to its own client id.
    if (owner === envelope.author && !checkUpdateAuthorship(update, await deriveClientId(publicKey)).ok) {
      complete = false
      continue
    }
    Y.applyUpdate(doc, update)
  }

  // An operation whose predecessor could not be opened waits for it forever.
  if (doc.store.pendingStructs !== null) complete = false
  return { state: Y.encodeStateAsUpdate(doc), complete }
}

/** For a record that has to name what it restored to. The same form a snapshot uses. */
export async function stateHash(state: Bytes): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", state as BufferSource)))
}

