"use client"

import * as React from "react"
import type * as Y from "yjs"

import type { SyncStatus } from "@/components/custom-ui/shared-note-bar/shared-note-bar"
import { useNotebookKeys } from "@/hooks/use-notebook-keys"
import { useNotebookWorkspace } from "@/hooks/use-notebook-workspace"
import { usePresenceRoom } from "@/hooks/use-presence-room"
import { currentDevice } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import {
  createNoteEngine,
  encryptedSyncEnabled,
  liveKeys,
  noteResourceId,
  openSyncSession,
  relayConnection,
  relayWatch,
  storedBaseline,
  storedCursor,
  notePresenceScope,
  type PresenceRoom,
} from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

export type EncryptedNoteState =
  /** Not wanted here, or no relay configured. */
  | "off"
  /** Wanted, but the owner or this device's keys are still being read. */
  | "pending"
  /** Wanted, and this device cannot read the notebook. */
  | "unavailable"
  | "running"

export interface EncryptedNoteSync {
  state: EncryptedNoteState
  status: SyncStatus
  lastSyncedAt: Date | null
  /** Holds keys to earlier epochs and not the current one: an admin removed it. */
  removed: boolean
  /** Where cursors meet this epoch. Null until there is a current key to derive it from. */
  presence: PresenceRoom | null
}

export interface UseEncryptedNoteSyncOptions {
  notebookId: string | null
  noteId: string | null
  doc: Y.Doc | null
  /** Whether this note is shared with members at all. */
  wanted: boolean
  /** Only the tab holding the writer lock may publish. */
  canAuthor: boolean
}

/**
 * Note content as encrypted envelopes through the relay.
 *
 * `pending` is a state of its own so the caller can hold off: falling back to
 * plaintext while keys load would put the content on the open room for exactly
 * the window it takes to read them.
 */
export function useEncryptedNoteSync(options: UseEncryptedNoteSyncOptions): EncryptedNoteSync {
  const { notebookId, noteId, doc, wanted, canAuthor } = options
  const enabled = wanted && encryptedSyncEnabled() && !!notebookId && !!noteId && !!doc

  const workspace = useNotebookWorkspace(enabled ? notebookId : null)
  const owner = workspace.workspace?.ownership.owner ?? null
  const keys = useNotebookKeys(enabled && owner ? notebookId : null, owner)
  const reader = keys.keys?.access === "reader"
  // Old keys still open old epochs, which is not the same as being a member.
  const keyring = reader && keys.keys?.current ? keys.keys.keyring : null
  const removed = enabled && reader && keys.keys?.current === false

  const state: EncryptedNoteState = !enabled
    ? "off"
    : workspace.loading || (owner !== null && keys.loading)
      ? "pending"
      : keyring && owner
        ? "running"
        : "unavailable"

  // Read through, so a new epoch reaches the running engine without a rebuild.
  const keyringRef = React.useRef<ReadKeySource | null>(null)
  React.useEffect(() => {
    if (keyring) keyringRef.current = keyring
  }, [keyring])

  const [status, setStatus] = React.useState<SyncStatus>("offline")
  const [lastSyncedAt, setLastSyncedAt] = React.useState<Date | null>(null)

  const running = state === "running"
  const presence = usePresenceRoom(
    running ? keyring : null,
    running && notebookId && noteId ? notePresenceScope(notebookId, noteId) : null,
  )
  React.useEffect(() => {
    if (!running || !notebookId || !noteId || !doc || !owner || !keyringRef.current) return
    const device = currentDevice()
    if (!device) return

    // Opened here rather than lazily, so the session sees the state it is in.
    relayConnection()
    const resourceId = noteResourceId(notebookId, noteId)
    const did = device.identity.did
    const engine = createNoteEngine({
      doc,
      index: createNotebookIndexDoc(notebookId).doc,
      notebookId,
      noteId,
      owner,
      keys: liveKeys(() => keyringRef.current!),
      cursor: storedCursor(did, resourceId),
    })
    const transport = relayConnection()?.transportFor(resourceId)
    if (!engine || !transport) {
      setStatus("offline")
      return
    }

    const session = openSyncSession({
      engine,
      doc,
      transport,
      resourceId,
      readableEpochs: () => keyringRef.current?.readableEpochs() ?? [],
      relay: relayWatch,
      baseline: storedBaseline(did, resourceId),
      canAuthor,
      onStatus: setStatus,
      onSynced: setLastSyncedAt,
      onError: (error) => {
        console.warn(`note sync ${noteId}`, error)
      },
    })

    return () => {
      session.close()
      engine.close()
      setStatus("offline")
    }
  }, [running, notebookId, noteId, doc, owner, canAuthor])

  return { state, status, lastSyncedAt, removed, presence }
}
