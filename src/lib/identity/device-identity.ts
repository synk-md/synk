/**
 * This device's identity: generated on first run, reloaded thereafter, so its
 * `did:key` and client id stay stable across reloads.
 *
 * There is no recovery path, by design - the key is non-extractable, so a lost
 * device is replaced by re-admission rather than restored.
 */

import {
  generateSealingKey,
  generateSigningKey,
  restoreSealingKey,
  restoreSigningKey,
  type SealingKey,
  type SigningKey,
} from "@/lib/crypto"
import { createDeviceRecord, verifyDeviceRecord, type DeviceRecord } from "./device-record"
import {
  loadStoredDeviceIdentity,
  saveStoredDeviceIdentity,
  clearStoredDeviceIdentity,
} from "./device-store"

export interface DeviceIdentity {
  /** `did:key` of the signing key. This device's name everywhere. */
  readonly did: string
  /** The Yjs client id this device is permitted to use. */
  readonly clientId: number
  readonly signingKey: SigningKey
  readonly sealingKey: SealingKey
  /** Self-signed, shareable. What the directory publishes. */
  readonly record: DeviceRecord
}

/**
 * In-flight and completed generation share one promise, so two callers racing
 * on first run cannot produce two identities and have one silently overwrite
 * the other.
 */
let identityPromise: Promise<DeviceIdentity> | null = null

async function loadOrCreate(): Promise<DeviceIdentity> {
  const stored = await loadStoredDeviceIdentity()

  if (stored) {
    const signingKey = await restoreSigningKey(stored.signing)
    const sealingKey = await restoreSealingKey(stored.sealing)
    // Re-verify on every load rather than trusting local storage. IndexedDB is
    // not a trust boundary: another script on the origin can write to it, and a
    // tampered record would silently redirect attribution or sealing.
    if (await verifyDeviceRecord(stored.record)) {
      return {
        did: stored.record.did,
        clientId: stored.record.clientId,
        signingKey,
        sealingKey,
        record: stored.record,
      }
    }
    // A stored record that does not verify is corrupt or tampered with. The
    // keys may still be sound, but the identity built on them is not
    // trustworthy, so it is discarded rather than repaired.
    await clearStoredDeviceIdentity()
  }

  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)

  await saveStoredDeviceIdentity({
    signing: signingKey.toStorable(),
    sealing: sealingKey.toStorable(),
    record,
  })

  return { did: record.did, clientId: record.clientId, signingKey, sealingKey, record }
}

/** The device identity, creating it on first run. Safe to call concurrently. */
export function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  if (!identityPromise) {
    identityPromise = loadOrCreate().catch((error: unknown) => {
      // Do not cache a failure - a transient IndexedDB error should not make the
      // device permanently identity-less for the life of the tab.
      identityPromise = null
      throw error
    })
  }
  return identityPromise
}

/**
 * Permanently destroy this device's identity and forget the cached handle.
 *
 * Irreversible: the key cannot be exported, so nothing survives this. The
 * device becomes a stranger and must be re-admitted. Exposed for tests and for
 * an explicit, confirmed "forget this device" action - never as error recovery.
 */
export async function forgetDeviceIdentity(): Promise<void> {
  identityPromise = null
  await clearStoredDeviceIdentity()
}

/** Drops the in-memory cache without touching storage. Test-only. */
export function resetDeviceIdentityCache(): void {
  identityPromise = null
}
