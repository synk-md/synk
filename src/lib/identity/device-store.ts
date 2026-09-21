/**
 * IndexedDB persistence for this device's identity and its per-document Yjs
 * clock watermarks.
 *
 * `CryptoKey` survives structured clone with `extractable: false` intact, which
 * is why keys live here rather than as exported bytes in localStorage.
 */

import type { StorableSealingKey, StorableSigningKey } from "@/lib/crypto"
import type { DeviceRecord } from "./device-record"

const DEVICE_DB = "synk-identity"
const DEVICE_DB_VERSION = 2
const DEVICE_STORE = "device"
const DEVICE_KEY = "self"

/**
 * Per-document Yjs clock high-water marks, keyed by `docId`.
 *
 * Per document, NOT per device: Yjs clocks are per document, so a device-global
 * mark would false-positive the moment a second, less-edited notebook opened.
 * In the same database as the key so the two share one eviction fate.
 */
const CLOCK_STORE = "clocks"

export interface StoredDeviceIdentity {
  id: typeof DEVICE_KEY
  signing: StorableSigningKey
  sealing: StorableSealingKey
  record: DeviceRecord
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDeviceDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB, DEVICE_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DEVICE_STORE)) {
        database.createObjectStore(DEVICE_STORE, { keyPath: "id" })
      }
      if (!database.objectStoreNames.contains(CLOCK_STORE)) {
        database.createObjectStore(CLOCK_STORE, { keyPath: "docId" })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error("Failed to open the device identity database"))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error("Opening the device identity database was blocked"))
    }
  })

  return databasePromise
}

export async function loadStoredDeviceIdentity(): Promise<StoredDeviceIdentity | undefined> {
  const database = await openDeviceDatabase()
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readonly")
    const request = transaction.objectStore(DEVICE_STORE).get(DEVICE_KEY)
    request.onsuccess = () => resolve(request.result as StoredDeviceIdentity | undefined)
    request.onerror = () => reject(request.error ?? new Error("Failed to read device identity"))
  })
}

export async function saveStoredDeviceIdentity(
  identity: Omit<StoredDeviceIdentity, "id">,
): Promise<void> {
  const database = await openDeviceDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite")
    transaction.objectStore(DEVICE_STORE).put({ ...identity, id: DEVICE_KEY })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to save identity"))
    transaction.onabort = () => reject(transaction.error ?? new Error("Save transaction aborted"))
  })
}

/**
 * Destroy this device's identity.
 *
 * This is not account deletion and not a recovery mechanism - it makes the
 * device a stranger. Because the private key was never extractable there is no
 * copy anywhere, so the identity is gone permanently and the device must be
 * re-admitted as a new one. See the recovery note in `device-identity.ts`.
 */
export async function clearStoredDeviceIdentity(): Promise<void> {
  const database = await openDeviceDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite")
    transaction.objectStore(DEVICE_STORE).delete(DEVICE_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to clear identity"))
  })
}

export interface StoredClockWatermark {
  docId: string
  clientId: number
  /** Highest Yjs clock this device has used in this document. */
  clock: number
  updatedAt: number
}

export async function loadClockWatermark(
  docId: string,
): Promise<StoredClockWatermark | undefined> {
  const database = await openDeviceDatabase()
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(CLOCK_STORE, "readonly")
    const request = transaction.objectStore(CLOCK_STORE).get(docId)
    request.onsuccess = () => resolve(request.result as StoredClockWatermark | undefined)
    request.onerror = () => reject(request.error ?? new Error("Failed to read clock watermark"))
  })
}

/**
 * Raise the stored watermark, monotonically.
 *
 * DO NOT split the get and the put into separate transactions. IndexedDB
 * serialises overlapping readwrite scopes across connections, and that is the
 * only thing making this compare-and-set atomic; two tabs share this database
 * and both run it against the same row. A racing-writer test guards the
 * refactor.
 */
export async function recordClockWatermark(
  docId: string,
  clientId: number,
  clock: number,
): Promise<void> {
  const database = await openDeviceDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CLOCK_STORE, "readwrite")
    const store = transaction.objectStore(CLOCK_STORE)
    const read = store.get(docId)
    read.onsuccess = () => {
      const existing = read.result as StoredClockWatermark | undefined
      if (!existing || clock > existing.clock) {
        store.put({ docId, clientId, clock, updatedAt: Date.now() })
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to record clock"))
    transaction.onabort = () => reject(transaction.error ?? new Error("Clock write aborted"))
  })
}

export async function clearClockWatermarks(): Promise<void> {
  const database = await openDeviceDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CLOCK_STORE, "readwrite")
    transaction.objectStore(CLOCK_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to clear clocks"))
  })
}

/** Drops the cached connection. Test-only. */
export function resetDeviceDatabaseConnection(): void {
  databasePromise = null
}
