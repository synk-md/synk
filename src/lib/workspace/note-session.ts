/**
 * Keeping one note's engine caught up with the relay for as long as it is open.
 *
 * An engine on its own only relays edits made while it is connected. Opening a
 * note also has to collect a baseline it can read, put right whatever an
 * earlier session left undelivered, and pull what arrived while it was away -
 * and do the last two again every time the relay comes back.
 */

import * as Y from "yjs"

import { collectJoinSnapshot, verifySnapshot } from "@/lib/snapshots"
import { REMOTE_ORIGIN, type SyncEngine, type Transport } from "@/lib/sync"

export type NoteSessionStatus = "offline" | "connecting" | "live"

export type RelayReachability = "offline" | "connecting" | "authenticating" | "online"

export interface RelayWatch {
  state(): RelayReachability
  onChange(listener: (state: RelayReachability) => void): () => void
}

/** Which baseline was applied, so it is applied once rather than on every open. */
export interface BaselineMemo {
  applied(): string | null
  record(snapshotId: string): void
}

export interface NoteSessionOptions {
  engine: SyncEngine
  doc: Y.Doc
  transport: Transport
  resourceId: string
  readableEpochs: () => number[]
  relay: RelayWatch
  baseline?: BaselineMemo
  /**
   * Whether this tab may author. A follower tab must not resume: it would
   * hand out numbers from the cursor the writing tab is using.
   */
  canAuthor: boolean
  onStatus?: (status: NoteSessionStatus) => void
  onSynced?: (at: Date) => void
  onError?: (error: unknown) => void
  retryMs?: number
}

export interface NoteSession {
  /** Resolves when the catch-up in flight, if any, has finished. */
  settled(): Promise<void>
  close(): void
}

export function openNoteSession(options: NoteSessionOptions): NoteSession {
  let closed = false
  let running: Promise<void> = Promise.resolve()
  let retry: ReturnType<typeof setTimeout> | undefined

  const report = (status: NoteSessionStatus) => {
    if (!closed) options.onStatus?.(status)
  }

  const applyBaseline = async () => {
    if (!options.baseline) return
    const snapshot = await collectJoinSnapshot({
      transport: options.transport,
      resourceId: options.resourceId,
      readableEpochs: options.readableEpochs(),
    })
    if (!snapshot || snapshot.id === options.baseline.applied()) return
    const applied = await options.engine.applySnapshot(snapshot, (candidate, author) =>
      verifySnapshot(candidate, author.publicKey),
    )
    if (applied) options.baseline.record(snapshot.id)
  }

  const catchUp = async () => {
    if (closed) return
    report("connecting")
    try {
      await applyBaseline()
      if (options.canAuthor) await options.engine.resume()
      await options.engine.sync()
      if (closed) return
      report("live")
      options.onSynced?.(new Date())
    } catch (error) {
      options.onError?.(error)
      if (closed) return
      // Online but failing is still not caught up. Try again rather than
      // leaving a status that only a reconnect would ever correct.
      clearTimeout(retry)
      retry = setTimeout(() => {
        schedule()
      }, options.retryMs ?? 5_000)
    }
  }

  // Serialised: a reconnect during a catch-up queues another behind it.
  const schedule = () => {
    running = running.then(catchUp)
  }

  const onRelay = (state: RelayReachability) => {
    if (state === "online") {
      schedule()
      return
    }
    clearTimeout(retry)
    report(state === "offline" ? "offline" : "connecting")
  }

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN && !closed) options.onSynced?.(new Date())
  }

  const stopWatching = options.relay.onChange(onRelay)
  options.doc.on("update", onUpdate)
  onRelay(options.relay.state())

  return {
    settled: () => running,
    close: () => {
      closed = true
      clearTimeout(retry)
      stopWatching()
      options.doc.off("update", onUpdate)
    },
  }
}
