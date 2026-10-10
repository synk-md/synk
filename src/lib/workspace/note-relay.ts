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

import { currentDevice } from "@/lib/identity"
import type { FlatKeyring } from "@/lib/keys"
import { RelayConnection, WebSocketLink } from "@/lib/relay"
import type { SyncEngine } from "@/lib/sync"

import { createNoteSyncEngine, noteResourceId } from "./note-sync"

// Read defensively: `import.meta.env` is Vite's, and this module is also
// imported by the Node smoke scripts, where it does not exist.
const env =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
const RELAY_URL = env.VITE_SYNK_RELAY_URL
const RELAY_ID = env.VITE_SYNK_RELAY_ID ?? "did:relay:dev"

/** True when note content should travel as envelopes rather than plaintext Yjs. */
export function encryptedSyncEnabled(): boolean {
  return typeof RELAY_URL === "string" && RELAY_URL.length > 0
}

let connection: RelayConnection | null = null
let link: WebSocketLink | null = null

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
    link = new WebSocketLink({ url: RELAY_URL! })
    connection = new RelayConnection({
      link,
      relayId: RELAY_ID,
      did: device.identity.did,
      signingKey: device.identity.signingKey,
      onError: (error) => {
        console.warn("relay", error)
      },
    })
  }
  return connection
}

export function closeRelayConnection(): void {
  connection?.close()
  link?.close()
  connection = null
  link = null
}

export interface NoteEngineOptions {
  doc: Y.Doc
  index: Y.Doc
  notebookId: string
  noteId: string
  owner: string
  keys: FlatKeyring
  onDenied?: (author: string, reason: string) => void
}

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
    transport: shared.transportFor(noteResourceId(options.notebookId, options.noteId)),
    ...(options.onDenied ? { onDenied: options.onDenied } : {}),
    onError: (error) => {
      console.warn(`note sync ${options.noteId}`, error)
    },
  })
}
