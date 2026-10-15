"use client"

import * as React from "react"
import * as Y from "yjs"

import { useNotebookKeys } from "@/hooks/use-notebook-keys"
import { useNotebookWorkspace } from "@/hooks/use-notebook-workspace"
import { buildTimeline, SnapshotCadence, type CadencePolicy, type RestorePoint } from "@/lib/history"
import { currentDevice, type User } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { keyDomainFor, noteResourceId, relayConnection } from "@/lib/workspace"
import { NoteHistory } from "@/lib/workspace/note-history"
import { storedCoverage } from "@/lib/workspace/stored-watermark"
import { getOrCreateYDoc } from "@/lib/yjs-utils"

/** How often to ask the cadence whether an anchor is due. */
const CHECK_EVERY_MS = 30_000

/**
 * Anchors for a shared note. Its timeline comes from the envelopes, so these
 * only bound how far back a point is rebuilt from - they can be sparse.
 */
export const ANCHOR_CADENCE: CadencePolicy = {
  everyUpdates: 2000,
  everyMs: 60 * 60 * 1000,
  minIntervalMs: 5 * 60 * 1000,
}

export interface NoteHistoryState {
  history: NoteHistory | null
  /** Whether this device holds a key to seal and open points with. */
  readable: boolean
  points: RestorePoint[]
  users: readonly User[]
  /** Fetch the points again - on opening the panel, and after a change. */
  refresh: () => Promise<void>
}

/**
 * A note's restore points, listed for the panel.
 *
 * Shared, they are the sessions in its envelopes, with anchors taken now and
 * then underneath. Not shared, nothing is taken on its own: the points are
 * the checkpoints someone saved. Only the tab doing the writing takes anchors,
 * so two tabs of one note do not take two of each.
 */
export function useNoteHistory(options: {
  notebookId: string | null
  noteId: string | null
  doc: Y.Doc | null
  canAuthor: boolean
  /** Also kept at the relay, for everyone else working on it. */
  shared: boolean
  checkEveryMs?: number
  cadence?: CadencePolicy
}): NoteHistoryState {
  const { notebookId, noteId, doc, canAuthor, shared } = options
  const checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS
  const policy = options.cadence ?? ANCHOR_CADENCE
  const { workspace } = useNotebookWorkspace(notebookId)
  const owner = workspace?.ownership.owner ?? null
  const keys = useNotebookKeys(notebookId && owner ? notebookId : null, owner)
  const keyring = keys.keys?.access === "reader" && keys.keys.current ? keys.keys.keyring : null

  const keyringRef = React.useRef<ReadKeySource | null>(null)
  keyringRef.current = keyring
  const sharedRef = React.useRef(shared)
  sharedRef.current = shared

  const history = React.useMemo(() => {
    const device = currentDevice()
    if (!notebookId || !noteId || !doc || !device) return null
    const { idb } = getOrCreateYDoc(notebookId, noteId)
    const resourceId = noteResourceId(notebookId, noteId)
    return new NoteHistory({
      notebookId,
      noteId,
      doc,
      storage: idb,
      device: device.identity,
      keys: () => keyringRef.current,
      transport: () => (sharedRef.current ? (relayConnection()?.transportFor(resourceId) ?? null) : null),
      covers: () => storedCoverage(idb),
    })
  }, [notebookId, noteId, doc])

  const readable = keyring !== null
  const epoch = keyring?.currentEpoch ?? null
  const cadenceRef = React.useRef<SnapshotCadence | null>(null)

  // Anchors as a shared note is edited, by activity and by time.
  React.useEffect(() => {
    if (!history || !doc || !canAuthor || !readable || !shared) return
    const cadence = new SnapshotCadence(policy)
    cadenceRef.current = cadence
    let taking = false
    const take = async () => {
      const keys = keyringRef.current
      if (taking || !keys) return
      taking = true
      try {
        await history.take("automatic")
        cadence.markTaken(Date.now(), keys.currentEpoch)
      } catch {
        // An anchor not taken now is taken at the next one due.
      } finally {
        taking = false
      }
    }
    const onUpdate = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      if (transaction.local) cadence.noteUpdate()
    }
    doc.on("update", onUpdate)
    const timer = setInterval(() => {
      if (cadence.due(Date.now())) void take()
    }, checkEveryMs)
    return () => {
      clearInterval(timer)
      doc.off("update", onUpdate)
      cadenceRef.current = null
    }
  }, [history, doc, canAuthor, readable, shared, checkEveryMs, policy])

  // A new epoch is a boundary worth a point of its own - one that changes while
  // the note is open, not the keys arriving when it opens.
  const seenEpochRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    const previous = seenEpochRef.current
    seenEpochRef.current = epoch
    if (epoch !== null && previous !== null && epoch !== previous) cadenceRef.current?.noteEpoch(epoch)
  }, [epoch])

  const [points, setPoints] = React.useState<RestorePoint[]>([])
  const users = React.useMemo(() => workspace?.users ?? [], [workspace])
  const refresh = React.useCallback(async () => {
    const keys = keyringRef.current
    if (!history || !keys) {
      setPoints([])
      return
    }
    const [snapshots, sessions] = await Promise.all([history.list(), history.sessions()])
    // Where sessions cover it, an automatic snapshot is only an anchor: the
    // sessions already say who wrote what and when. Older ones stay listed.
    const since = sessions[0]?.from ?? Infinity
    const shown = snapshots.filter((snapshot) => snapshot.kind !== "automatic" || snapshot.createdAt < since)
    const domain = keyDomainFor(history.notebookId)
    setPoints(
      buildTimeline({
        entries: shown.map((snapshot) => ({ ...snapshot, materialised: true as const })),
        sessions: sessions.map((session) => ({
          id: session.id,
          resourceId: history.resourceId,
          domain,
          author: session.author,
          createdAt: session.to,
          epochs: session.epochs,
          changes: session.changes,
        })),
        users,
        readableEpochs: keys.readableEpochs(),
      }),
    )
  }, [history, users])

  return { history, readable, points, users, refresh }
}
