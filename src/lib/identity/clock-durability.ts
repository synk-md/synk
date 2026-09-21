/**
 * Enforces the clock-durability invariant that a stable client id imposes.
 *
 * Yjs identifies operations by `(client, clock)`; reusing a pair is silent,
 * unrecoverable corruption. A permanent client id means the per-document clock
 * must never rewind, so it is persisted beside the key and checked before a
 * document is allowed to author.
 */

import * as Y from "yjs"
import {
  loadClockWatermark,
  recordClockWatermark,
  type StoredClockWatermark,
} from "./device-store"

/**
 * Thrown when a document's clock is behind what this device has already
 * published. A typed error rather than a boolean because there is no safe way
 * to continue: every caller must either stop or re-identify.
 */
export class ClockRegressionError extends Error {
  readonly docId: string
  readonly clientId: number
  /** Highest clock this device is known to have used. */
  readonly storedClock: number
  /** What the document currently reports, which is lower. */
  readonly observedClock: number

  constructor(docId: string, clientId: number, storedClock: number, observedClock: number) {
    super(
      `Yjs clock regression in "${docId}" for client ${clientId}: ` +
        `document is at ${observedClock} but this device already published up to ${storedClock}. ` +
        `Document state was lost while the device identity survived. Continuing would reissue ` +
        `(client, clock) pairs and corrupt the document. Take a fresh identity (re-admission ` +
        `required) or do not author in this document with this key.`,
    )
    this.name = "ClockRegressionError"
    this.docId = docId
    this.clientId = clientId
    this.storedClock = storedClock
    this.observedClock = observedClock
  }
}

/**
 * The next clock this device would use in `doc`.
 *
 * Read through the public state-vector API rather than reaching into
 * `doc.store`, so it stays correct across Yjs internals changes.
 */
export function currentDocumentClock(doc: Y.Doc, clientId: number): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(clientId) ?? 0
}

export interface ClockDurabilityStatus {
  docId: string
  clientId: number
  storedClock: number
  observedClock: number
  /** True when the document is behind what this device already published. */
  regressed: boolean
}

/** Inspect without throwing - for diagnostics and for deciding a remedy. */
export async function checkClockDurability(
  doc: Y.Doc,
  docId: string,
  clientId: number,
): Promise<ClockDurabilityStatus> {
  const stored: StoredClockWatermark | undefined = await loadClockWatermark(docId)
  const observedClock = currentDocumentClock(doc, clientId)
  const storedClock = stored?.clock ?? 0
  return {
    docId,
    clientId,
    storedClock,
    observedClock,
    regressed: observedClock < storedClock,
  }
}

/**
 * Gate on the invariant. Call before a document is allowed to author anything;
 * throws `ClockRegressionError` if the document has rewound.
 */
export async function assertClockDurability(
  doc: Y.Doc,
  docId: string,
  clientId: number,
): Promise<void> {
  const status = await checkClockDurability(doc, docId, clientId)
  if (status.regressed) {
    throw new ClockRegressionError(docId, clientId, status.storedClock, status.observedClock)
  }
}

export interface TrackDocumentClockOptions {
  /**
   * Called when a watermark write fails. Persistence failing means the
   * invariant is no longer being maintained, which is worth surfacing rather
   * than swallowing - but it must not break editing, so it is a callback
   * instead of a throw.
   */
  onError?: (error: unknown) => void
}

/**
 * Keep the persisted watermark current as the device authors. Local updates
 * only. Writes are serialised because out-of-order completions would hit the
 * store's monotonic guard and quietly lower the mark. Returns an unsubscribe.
 */
export function trackDocumentClock(
  doc: Y.Doc,
  docId: string,
  clientId: number,
  options: TrackDocumentClockOptions = {},
): () => void {
  let queue: Promise<void> = Promise.resolve()

  const handler = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (!transaction.local) return
    const clock = currentDocumentClock(doc, clientId)
    queue = queue
      .then(() => recordClockWatermark(docId, clientId, clock))
      .catch((error: unknown) => {
        options.onError?.(error)
      })
  }

  doc.on("update", handler)
  return () => {
    doc.off("update", handler)
  }
}

/**
 * Bind a document to this device's client id with the invariant enforced.
 *
 * The intended entry point: it verifies the clock has not rewound, pins the
 * document's client id, records the current mark, and starts tracking. Throws
 * `ClockRegressionError` before pinning, so a document that failed the check is
 * never left carrying this device's id.
 */
export async function attachDocumentClock(
  doc: Y.Doc,
  docId: string,
  clientId: number,
  options: TrackDocumentClockOptions = {},
): Promise<() => void> {
  await assertClockDurability(doc, docId, clientId)
  doc.clientID = clientId
  await recordClockWatermark(docId, clientId, currentDocumentClock(doc, clientId))
  return trackDocumentClock(doc, docId, clientId, options)
}
