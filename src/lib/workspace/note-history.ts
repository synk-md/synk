/**
 * A note's restore points: where they are kept, and taking and using them.
 *
 * A shared note's history is its envelopes, grouped into sessions; snapshots
 * there are anchors that keep rebuilding a point short, plus the checkpoints
 * someone named. A note nobody else uses has no envelopes, so its history is
 * the checkpoints taken by hand.
 *
 * Snapshots are sealed under the notebook's current key, so the history is
 * exactly as private as the note. They are kept in the note's own IndexedDB
 * and, for a shared note, also at the relay.
 *
 * Imported by path, not through the workspace barrel: it reaches IndexedDB.
 */

import type { IndexeddbPersistence } from "y-indexeddb"
import * as Y from "yjs"

import {
  applyRestore,
  applyRestoreToState,
  planRestore,
  planRestoreToState,
  type ApplyRestoreOptions,
  type RestorePlan,
  type RestoreRecord,
  type RestoreTarget,
} from "@/lib/history"
import type { DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { createSnapshot, type Snapshot } from "@/lib/snapshots"
import type { Bytes } from "@/lib/crypto"
import type { DeliveryVector, Envelope, Transport } from "@/lib/sync"

import { sessionsOf, stateAt, stateHash, type Session } from "./envelope-history"
import { keyDomainFor } from "./notebook-keys"
import { noteResourceId } from "./note-sync"

const KEY = "synk:history"

/** Automatic points kept on this device. Named checkpoints are kept regardless. */
export const KEEP_AUTOMATIC = 30

/** Where a restore is recorded: in the note, so it travels with it. */
export const RESTORE_MAP = "history:restores"

export interface NoteHistoryOptions {
  notebookId: string
  noteId: string
  doc: Y.Doc
  /** The note's own database, which keeps the points beside the content. */
  storage: IndexeddbPersistence
  device: DeviceIdentity
  /** The notebook's keys now, or null when this device cannot read them. */
  keys: () => ReadKeySource | null
  /** The relay archive, for a note shared with anyone. */
  transport?: () => Transport | null
  /** How far the document is known to contain, so a point opened later knows where it stands. */
  covers?: () => Promise<DeliveryVector>
  keep?: number
}

function isSnapshot(value: unknown): value is Snapshot {
  const candidate = value as Snapshot | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    typeof candidate.ct === "string" &&
    Array.isArray(candidate.wraps)
  )
}

export class NoteHistory {
  private readonly options: NoteHistoryOptions
  readonly notebookId: string
  readonly resourceId: string
  /** The envelopes the sessions were last listed from, so a point opens what was shown. */
  private envelopes: Envelope[] = []
  private floor: DeliveryVector = {}
  private listed: Session[] = []

  constructor(options: NoteHistoryOptions) {
    this.options = options
    this.notebookId = options.notebookId
    this.resourceId = noteResourceId(options.notebookId, options.noteId)
  }

  private async local(): Promise<Snapshot[]> {
    try {
      const raw: unknown = await this.options.storage.get(KEY)
      const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter(isSnapshot) : []
    } catch {
      return []
    }
  }

  /** Every named checkpoint, and the newest automatic points. */
  private async keepLocal(list: readonly Snapshot[]): Promise<void> {
    const keep = this.options.keep ?? KEEP_AUTOMATIC
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt)
    const automatic = sorted.filter((snapshot) => snapshot.kind !== "checkpoint")
    const dropped = new Set(automatic.slice(0, Math.max(0, automatic.length - keep)).map((snapshot) => snapshot.id))
    await this.options.storage.set(KEY, JSON.stringify(sorted.filter((snapshot) => !dropped.has(snapshot.id))))
  }

  /** Points held here and at the relay, oldest first. */
  async list(): Promise<Snapshot[]> {
    const held = await this.local()
    const archived = (await this.options.transport?.()?.fetchSnapshots(this.resourceId).catch(() => [])) ?? []
    const byId = new Map<string, Snapshot>()
    for (const snapshot of [...held, ...archived]) {
      if (snapshot.resourceId === this.resourceId) byId.set(snapshot.id, snapshot)
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** A shared note's sessions, oldest first. None for a note kept here only. */
  async sessions(): Promise<Session[]> {
    const transport = this.options.transport?.()
    if (!transport) return []
    try {
      const [envelopes, floor] = await Promise.all([transport.fetchSince({}), transport.floor?.() ?? {}])
      this.envelopes = envelopes
      this.floor = floor
    } catch {
      return this.listed
    }
    this.listed = sessionsOf(
      this.envelopes.filter((envelope) => envelope.resourceId === this.resourceId),
      { floor: this.floor },
    )
    return this.listed
  }

  /**
   * Take a point now. Null when there is no key to seal it under, or - for an
   * automatic one - when nothing changed since the last, which would only
   * repeat it.
   */
  async take(kind: "automatic" | "checkpoint", label?: string): Promise<Snapshot | null> {
    const keys = this.options.keys()
    const dek = keys ? await keys.keyFor(keys.currentEpoch) : undefined
    if (!keys || !dek) return null

    const held = await this.local()
    const previous = held.reduce<Snapshot | null>(
      (latest, snapshot) => (!latest || snapshot.createdAt > latest.createdAt ? snapshot : latest),
      null,
    )
    const snapshot = await createSnapshot({
      signingKey: this.options.device.signingKey,
      author: this.options.device.did,
      domain: keyDomainFor(this.options.notebookId),
      resourceId: this.resourceId,
      kind,
      epoch: keys.currentEpoch,
      dek,
      state: Y.encodeStateAsUpdate(this.options.doc),
      covers: (await this.options.covers?.()) ?? {},
      parent: previous?.id ?? null,
      ...(label === undefined ? {} : { label }),
    })
    if (kind === "automatic" && previous?.stateHash === snapshot.stateHash) return null

    await this.keepLocal([...held, snapshot])
    await this.options.transport?.()?.depositSnapshot(snapshot)
    return snapshot
  }

  private async target(id: string): Promise<Snapshot> {
    const target = (await this.list()).find((snapshot) => snapshot.id === id)
    if (!target) throw new Error("that restore point is no longer here")
    return target
  }

  private readable(): ReadKeySource {
    const keys = this.options.keys()
    if (!keys) throw new Error("this device cannot read the notebook's keys")
    return keys
  }

  /** The note as it stood when a session ended, rebuilt from the nearest anchor. */
  private async rebuilt(session: Session): Promise<{ target: RestoreTarget; state: Bytes }> {
    const { state, complete } = await stateAt({
      cut: session.end,
      anchors: await this.list(),
      envelopes: this.envelopes,
      keys: this.readable(),
      floor: this.floor,
    })
    // Restoring a partial state would delete whatever could not be opened.
    if (!complete) throw new Error("Part of this point is sealed under a key this device does not hold.")
    const target = {
      id: session.id,
      resourceId: this.resourceId,
      domain: keyDomainFor(this.options.notebookId),
      stateHash: await stateHash(state),
    }
    return { target, state }
  }

  private session(id: string): Session | undefined {
    return this.listed.find((session) => session.id === id)
  }

  async plan(id: string): Promise<RestorePlan> {
    const session = this.session(id)
    if (session) return planRestoreToState({ doc: this.options.doc, ...(await this.rebuilt(session)) })
    return planRestore({ doc: this.options.doc, target: await this.target(id), keys: this.readable() })
  }

  /**
   * Make the note look like the point again: an ordinary edit, synced like
   * any other, with a signed record of whose words came back.
   */
  async restore(id: string): Promise<RestoreRecord> {
    const how: ApplyRestoreOptions = {
      doc: this.options.doc,
      signingKey: this.options.device.signingKey,
      actor: this.options.device.did,
      // Whether this device may write is the editor's to say, and it does not
      // offer restoring where it may not. Peers check again on arrival.
      canWrite: () => true,
      supersedes: (await this.options.covers?.()) ?? {},
      transact: (fn) => this.options.doc.transact(fn),
    }
    const session = this.session(id)
    const { record } = session
      ? await applyRestoreToState({ ...how, ...(await this.rebuilt(session)) })
      : await applyRestore({ ...how, target: await this.target(id), keys: this.readable() })
    this.options.doc.getMap<RestoreRecord>(RESTORE_MAP).set(`${record.target}@${String(record.restoredAt)}`, record)
    return record
  }
}
