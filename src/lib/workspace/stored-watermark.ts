/**
 * A document's delivery watermark, kept in that document's own IndexedDB.
 *
 * In the same database on purpose: clearing a note's storage clears its
 * watermark with it, so the two can never disagree about what is held.
 *
 * Imported by path, not through the workspace barrel - it reaches IndexedDB,
 * and the barrel is loaded by the test setup before any test can mock that.
 */

import type { IndexeddbPersistence } from "y-indexeddb"

import type { DeliveryVector } from "@/lib/sync"
import { flushPersistence } from "@/lib/yjs-utils"

import type { DeliveryWatermark } from "./sync-session"

const KEY = "synk:delivered"

function isVector(value: unknown): value is DeliveryVector {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((seq) => Number.isSafeInteger(seq) && (seq as number) >= 0)
  )
}

export function storedWatermark(storage: IndexeddbPersistence): DeliveryWatermark {
  return {
    load: async () => {
      try {
        const raw: unknown = await storage.get(KEY)
        const value: unknown = typeof raw === "string" ? JSON.parse(raw) : null
        return isVector(value) ? value : null
      } catch {
        // Unreadable means unknown, and unknown means replay everything.
        return null
      }
    },
    durable: () => flushPersistence(storage),
    save: async (vector) => {
      await storage.set(KEY, JSON.stringify(vector))
    },
  }
}

/** For a join snapshot: how far this document is known to contain. */
export async function storedCoverage(storage: IndexeddbPersistence): Promise<DeliveryVector> {
  return (await storedWatermark(storage).load()) ?? {}
}
