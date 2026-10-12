/**
 * Keeping one document's engine caught up with the relay while it is open.
 *
 * An engine on its own only relays edits made while it is connected. Opening a
 * document also has to collect a baseline it can read, put right whatever an
 * earlier session left undelivered, and pull what arrived while it was away -
 * and do the last two again every time the relay comes back.
 *
 * Notes recover with `resume`, which needs a per-device cursor and so a writer
 * lock. The directory and the tree are small and written from any tab, so they
 * recover by publishing their whole state instead.
 */

import * as Y from "yjs"

import { collectJoinSnapshot, verifySnapshot } from "@/lib/snapshots"
import { REMOTE_ORIGIN, type DeliveryVector, type SyncEngine, type Transport } from "@/lib/sync"

export type SyncSessionStatus = "offline" | "connecting" | "live"

export type RelayReachability = "offline" | "connecting" | "authenticating" | "online"

export interface RelayWatch {
  state(): RelayReachability
  onChange(listener: (state: RelayReachability) => void): () => void
}

/**
 * How far this document has received, kept with the document itself.
 *
 * What makes a reopened note fetch only what is new rather than replaying its
 * whole history. It must never run ahead of what storage holds, or this device
 * would skip operations for good - so it is saved only after a flush, and kept
 * in the document's own database, so clearing one clears both.
 */
export interface DeliveryWatermark {
  load(): Promise<DeliveryVector | null>
  /** Resolves once everything applied so far is in storage. */
  durable(): Promise<void>
  save(vector: DeliveryVector): Promise<void>
}

/** Set by any local edit; cleared once everything sent is known to have arrived. */
export interface UnsentFlag {
  get(): boolean
  clear(): void
}

/** Which baseline was applied, so it is applied once rather than on every open. */
export interface BaselineMemo {
  applied(): string | null
  record(snapshotId: string): void
}

export interface SyncSessionOptions {
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
  /** Defaults to `resume`. */
  recover?: "resume" | "publish-state"
  watermark?: DeliveryWatermark
  /** For `publish-state`: republish only when this says something may be missing. */
  unsent?: UnsentFlag
  /** How long to wait after activity before saving the watermark. */
  settleMs?: number
  onStatus?: (status: SyncSessionStatus) => void
  onSynced?: (at: Date) => void
  onError?: (error: unknown) => void
  retryMs?: number
}

export interface SyncSession {
  /** Resolves when the catch-up in flight, if any, has finished. */
  settled(): Promise<void>
  /** Catch up again now and republish, for a change the relay has no way to signal. */
  refresh(): void
  close(): void
}

export function openSyncSession(options: SyncSessionOptions): SyncSession {
  let closed = false
  let running: Promise<void> = Promise.resolve()
  let retry: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let loaded = false
  let force = false
  let saving: Promise<void> = Promise.resolve()

  const report = (status: SyncSessionStatus) => {
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

  // Before anything is fetched, so the first catch-up asks only for what is new.
  const loadWatermark = async () => {
    if (loaded || !options.watermark) return
    loaded = true
    const saved = await options.watermark.load()
    if (saved) options.engine.log.markCovered(saved)
  }

  const persist = () => {
    const watermark = options.watermark
    if (!watermark) return
    // Captured first: the flush that follows then covers everything it claims.
    const vector = options.engine.deliveryVector()
    saving = saving
      .then(async () => {
        await watermark.durable()
        await watermark.save(vector)
      })
      .catch((error: unknown) => {
        options.onError?.(error)
      })
  }

  /**
   * Whether the relay may lack something this device holds. Publishing the
   * whole document on every open is what made the relay grow without bound.
   */
  const stateMissing = async (): Promise<boolean> => {
    if (force || options.unsent?.get()) return true
    const theirs = await options.transport.vector()
    if (Object.keys(theirs).length === 0) return Y.encodeStateVector(options.doc).length > 1
    // Held here and not there: the relay was restarted, or lost it.
    return Object.entries(options.engine.deliveryVector()).some(
      ([author, seq]) => (theirs[author] ?? 0) < seq,
    )
  }

  const clearUnsent = async () => {
    if (options.unsent && (await options.engine.delivered())) options.unsent.clear()
  }

  const catchUp = async () => {
    if (closed) return
    report("connecting")
    try {
      await loadWatermark()
      await applyBaseline()
      if (options.recover === "publish-state") {
        await options.engine.sync()
        if (options.canAuthor && (await stateMissing())) await options.engine.publishState()
        force = false
        await clearUnsent()
      } else {
        if (options.canAuthor) await options.engine.resume()
        await options.engine.sync()
      }
      if (closed) return
      persist()
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

  // Saved after activity settles rather than per update: a flush per keystroke
  // would cost more than the replay it saves.
  const settle = () => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      persist()
      void clearUnsent().catch(() => undefined)
    }, options.settleMs ?? 2_000)
  }

  const onUpdate = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (closed) return
    if (origin === REMOTE_ORIGIN) options.onSynced?.(new Date())
    if (origin === REMOTE_ORIGIN || transaction.local) settle()
  }

  const stopWatching = options.relay.onChange(onRelay)
  options.doc.on("update", onUpdate)
  onRelay(options.relay.state())

  return {
    settled: () => running,
    refresh: () => {
      if (options.relay.state() !== "online") return
      force = true
      schedule()
    },
    close: () => {
      if (!closed) persist()
      closed = true
      clearTimeout(retry)
      clearTimeout(settleTimer)
      stopWatching()
      options.doc.off("update", onUpdate)
    },
  }
}
