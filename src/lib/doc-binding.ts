/**
 * Binding an editor document to this device's identity.
 *
 * Two things have to be true before a document may author anything, and they
 * are linked: the Yjs client id must be this device's derived one, and no other
 * tab may be authoring under it at the same time.
 *
 * The second follows from the first. Yjs normally hands each tab a random client
 * id, so two tabs of the same document never collide. A *derived* id is the same
 * in every tab of the same browser profile, so pinning it creates exactly the
 * collision the random id was avoiding - two contexts writing distinct
 * operations under one `(client, clock)` space, which is silent and
 * unrecoverable corruption. Pinning without the lock would be worse than not
 * pinning at all.
 *
 * So a document comes back with a status rather than a boolean, and a follower
 * is told it is a follower instead of quietly losing its edits.
 */

import * as Y from "yjs"

import {
  attachDocumentClock,
  checkClockDurability,
  currentDevice,
  type ClockDurabilityStatus,
} from "@/lib/identity"
import { SingleWriterGuard, writerLockName, type LockBackend } from "@/lib/sync"

export type DocBindingStatus =
  /** Pinned, sole writer, invariant holding. Normal. */
  | "writer"
  /** Another tab holds the lock. This one must not author. */
  | "follower"
  /** The document is behind what this device already published. */
  | "regressed"
  /** No device identity, so nothing was pinned. */
  | "unidentified"

export interface DocBinding {
  docId: string
  status: DocBindingStatus
  /** The client id the document is pinned to, when one was available. */
  clientId: number | null
  /** Present when the clock check ran. */
  clock: ClockDurabilityStatus | null
  detail: string | null
}

export interface BoundDoc {
  binding: Promise<DocBinding>
  /** Current value, for callers that cannot await. */
  current(): DocBinding
  release(): void
}

function pending(docId: string): DocBinding {
  return { docId, status: "unidentified", clientId: null, clock: null, detail: null }
}

/**
 * Pin the id now, verify the invariant once storage has loaded.
 *
 * The order matters. Pinning is synchronous so the first keystroke is already
 * attributable; the durability check has to wait for IndexedDB, because an
 * empty document looks exactly like a rewound one until its contents arrive.
 */
export function bindDoc(
  doc: Y.Doc,
  docId: string,
  whenStorageReady: Promise<unknown>,
  options: { onError?: (error: unknown) => void; lockBackend?: LockBackend } = {},
): BoundDoc {
  const device = currentDevice()
  let value = pending(docId)
  let stopTracking: (() => void) | undefined
  let guard: SingleWriterGuard | undefined

  if (!device) {
    value = {
      ...value,
      detail: "This device has no identity yet, so edits cannot be attributed.",
    }
    const settled = Promise.resolve(value)
    return { binding: settled, current: () => value, release: () => undefined }
  }

  // Before anything else, and synchronously: an edit made in the gap would
  // carry an id no peer accepts.
  doc.clientID = device.clientId
  value = { ...value, status: "writer", clientId: device.clientId }

  const binding = (async (): Promise<DocBinding> => {
    guard = new SingleWriterGuard({
      name: writerLockName(device.identity.did, docId),
      ...(options.lockBackend ? { backend: options.lockBackend } : {}),
    })
    const writer = await guard.claim()

    await whenStorageReady

    const clock = await checkClockDurability(doc, docId, device.clientId)
    if (clock.regressed) {
      value = {
        docId,
        status: "regressed",
        clientId: device.clientId,
        clock,
        detail: `This device has already published up to clock ${String(clock.storedClock)} for this note, but only ${String(clock.observedClock)} is here. Writing now would reuse operation ids.`,
      }
      return value
    }

    if (writer === "follower") {
      value = {
        docId,
        status: "follower",
        clientId: device.clientId,
        clock,
        detail: "This note is open in another tab, which is doing the writing.",
      }
      return value
    }

    // `unavailable` means no Web Locks - a non-secure context, or an old
    // browser. Reported as writing, because refusing to edit over a missing
    // lock API would be a worse outcome than the collision it guards against.
    stopTracking = await attachDocumentClock(doc, docId, device.clientId, {
      ...(options.onError ? { onError: options.onError } : {}),
    })
    value = {
      docId,
      status: "writer",
      clientId: device.clientId,
      clock,
      detail:
        writer === "unavailable"
          ? "This browser cannot coordinate between tabs, so keep this note open in one tab only."
          : null,
    }
    return value
  })().catch((error: unknown) => {
    options.onError?.(error)
    value = {
      ...value,
      status: "unidentified",
      detail: error instanceof Error ? error.message : "Could not bind this note to this device.",
    }
    return value
  })

  return {
    binding,
    current: () => value,
    release: () => {
      stopTracking?.()
      guard?.yield()
    },
  }
}
