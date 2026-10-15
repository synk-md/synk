/**
 * The app's one relay connection, and the note engines over it.
 *
 * Behind a flag. Three slices running have passed their suites and failed in a
 * browser, every time at a seam where something real replaced something faked,
 * and this slice replaces the most - so the existing path stays the default
 * until this one has been driven by hand.
 *
 * Set `VITE_SYNK_RELAY_URL` to turn it on.
 */

import type * as Y from "yjs"

import { currentDevice, type DeviceIdentity } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { RelayConnection, WebSocketLink, type RelayConnectionState } from "@/lib/relay"
import type { SyncCursor, SyncCursorStore, SyncEngine } from "@/lib/sync"

import { resolveOwnership } from "./genesis"
import { genesisClaims, workspaceIdFor } from "./notebook-workspace"
import type { BaselineMemo, RelayWatch } from "./sync-session"
import { createNoteSyncEngine, noteResourceId } from "./note-sync"

// Read defensively: `import.meta.env` is Vite's, and this module is also
// imported by the Node smoke scripts, where it does not exist.
const env =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export interface RelaySettings {
  /** Null or empty turns encrypted sync off. */
  url: string | null
  relayId: string
}

/**
 * Where the relay is, and therefore whether encrypted sync is on at all.
 *
 * Configurable rather than read straight from the environment. Vite inlines
 * `import.meta.env` at build time, so a value baked in there cannot be changed
 * by anything later - which makes the suite depend on whoever's `.env.local` it
 * ran with, and would make a settings screen impossible. The environment is the
 * default; this is the setting.
 */
let settings: RelaySettings = {
  url: env.VITE_SYNK_RELAY_URL ?? null,
  relayId: env.VITE_SYNK_RELAY_ID ?? "did:relay:dev",
}

export function configureRelay(next: Partial<RelaySettings>): void {
  settings = { ...settings, ...next }
  // A changed address makes the open connection the wrong one.
  closeRelayConnection()
}

export function relaySettings(): RelaySettings {
  return settings
}

/** True when note content should travel as envelopes rather than plaintext Yjs. */
export function encryptedSyncEnabled(): boolean {
  return typeof settings.url === "string" && settings.url.length > 0
}

let connection: RelayConnection | null = null
let link: WebSocketLink | null = null
// The connection takes one callback; every open note needs to hear it.
const stateListeners = new Set<(state: RelayConnectionState) => void>()

/**
 * The shared connection, opened on first use.
 *
 * One per app rather than one per note: a notebook syncs several notes at once
 * and a socket each would mean a handshake each.
 */
export function relayConnection(): RelayConnection | null {
  if (!encryptedSyncEnabled()) return null
  const device = currentDevice()
  if (!device) return null

  if (!connection) {
    link = new WebSocketLink({ url: settings.url! })
    connection = new RelayConnection({
      link,
      relayId: settings.relayId,
      did: device.identity.did,
      signingKey: device.identity.signingKey,
      onConnectionChange: (state) => {
        for (const listener of stateListeners) listener(state)
      },
      onError: (error) => {
        console.warn("relay", error)
      },
    })
  }
  return connection
}

/**
 * As the owner, say so to the relay - which is what lets it let envelopes go
 * behind this device's anchors. Anywhere else, nothing.
 */
export async function claimOwnershipAtRelay(options: {
  doc: Y.Doc
  notebookId: string
  device: DeviceIdentity
}): Promise<boolean> {
  const connection = relayConnection()
  if (!connection) return false
  const ownership = await resolveOwnership(genesisClaims(options.doc), {
    workspace: workspaceIdFor(options.notebookId),
  })
  if (ownership.owner !== options.device.did || !ownership.genesis) return false
  return connection.claimOwnership(ownership.genesis)
}

export function closeRelayConnection(): void {
  connection?.close()
  link?.close()
  connection = null
  link = null
}

/** Whether the relay is reachable, for anything that has to react to it. */
export const relayWatch: RelayWatch = {
  state: () => relayConnection()?.state ?? "offline",
  onChange: (listener) => {
    stateListeners.add(listener)
    return () => {
      stateListeners.delete(listener)
    }
  },
}

function stored<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  return {
    load: (): T => {
      try {
        const raw = localStorage.getItem(key)
        const value: unknown = raw === null ? null : JSON.parse(raw)
        return valid(value) ? value : fallback
      } catch {
        return fallback
      }
    },
    save: (value: T): void => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Unavailable storage degrades to memory. `resume` still refuses to
        // reuse anything the relay already holds.
      }
    },
  }
}

const isCursor = (value: unknown): value is SyncCursor =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger((value as SyncCursor).seq) &&
  Number.isSafeInteger((value as SyncCursor).clock)

/** Per device and note: two devices never share numbering, two tabs always do. */
export function storedCursor(did: string, resourceId: string): SyncCursorStore {
  return stored(`synk:cursor:${did}:${resourceId}`, { seq: 0, clock: 0 }, isCursor)
}

export function storedBaseline(did: string, resourceId: string): BaselineMemo {
  const slot = stored(
    `synk:baseline:${did}:${resourceId}`,
    null,
    (value): value is string | null => value === null || typeof value === "string",
  )
  return { applied: slot.load, record: slot.save }
}

/**
 * A keyring that is always the latest one read.
 *
 * The notebook's keys are re-read on every directory change, and an engine
 * rebuilt each time would re-run its whole catch-up. This lets one engine see
 * a new epoch the moment it is cut.
 */
export function liveKeys(read: () => ReadKeySource): ReadKeySource {
  return {
    get domain() {
      return read().domain
    },
    get currentEpoch() {
      return read().currentEpoch
    },
    keyFor: (epoch) => read().keyFor(epoch),
    readableEpochs: () => read().readableEpochs(),
  }
}

export interface NoteEngineOptions {
  doc: Y.Doc
  index: Y.Doc
  notebookId: string
  noteId: string
  owner: string
  keys: ReadKeySource
  cursor: SyncCursorStore
  onDenied?: (author: string, reason: string) => void
}

/**
 * How long typing is gathered into one envelope. Long enough to fold a burst
 * of keystrokes into one, short enough that a collaborator does not notice.
 */
export const NOTE_BATCH_MS = 250

/**
 * An engine for one note, or null when encrypted sync is off or unusable.
 *
 * Returns null rather than throwing on a missing identity, owner or keyring:
 * each is an ordinary state - a notebook with no recorded owner, a device that
 * holds no keys - and none of them should stop the editor loading.
 */
export function createNoteEngine(options: NoteEngineOptions): SyncEngine | null {
  const shared = relayConnection()
  const device = currentDevice()
  if (!shared || !device) return null

  return createNoteSyncEngine({
    doc: options.doc,
    notebookId: options.notebookId,
    noteId: options.noteId,
    index: options.index,
    owner: options.owner,
    author: device.identity.did,
    signingKey: device.identity.signingKey,
    clientId: device.clientId,
    keys: options.keys,
    cursor: options.cursor,
    batchMs: NOTE_BATCH_MS,
    transport: shared.transportFor(noteResourceId(options.notebookId, options.noteId)),
    ...(options.onDenied ? { onDenied: options.onDenied } : {}),
    onError: (error) => {
      console.warn(`note sync ${options.noteId}`, error)
    },
  })
}
