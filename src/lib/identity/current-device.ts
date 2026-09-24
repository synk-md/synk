/**
 * This device's identity, available synchronously once the app has booted.
 *
 * Documents are created on render paths that cannot await, and a document has
 * to carry the right client id from its very first edit - binding it later
 * leaves a window in which operations are authored under a random id that no
 * peer will accept. So the identity is resolved once at startup and held here.
 *
 * `currentDevice()` returns null rather than throwing when boot has not
 * finished or failed outright. Editing locally does not depend on having an
 * identity, and taking the app down because a key store was unavailable would
 * trade a degraded feature for a dead one.
 */

import { deriveClientId } from "./client-id"
import { getOrCreateDeviceIdentity, type DeviceIdentity } from "./device-identity"

export interface CurrentDevice {
  identity: DeviceIdentity
  /** The one Yjs client id this device may author under. */
  clientId: number
}

let current: CurrentDevice | null = null
let boot: Promise<CurrentDevice | null> | undefined
let failure: Error | null = null

/** Resolve and cache the identity. Safe to call more than once. */
export function initCurrentDevice(): Promise<CurrentDevice | null> {
  boot ??= (async () => {
    try {
      const identity = await getOrCreateDeviceIdentity()
      current = { identity, clientId: await deriveClientId(identity.signingKey.publicKey) }
      failure = null
      return current
    } catch (error) {
      failure = error instanceof Error ? error : new Error("could not load this device's identity")
      current = null
      return null
    }
  })()
  return boot
}

export function currentDevice(): CurrentDevice | null {
  return current
}

/** Why there is no identity, when there is none. */
export function currentDeviceError(): Error | null {
  return failure
}

/** For tests, and for the sign-out path once one exists. */
export function resetCurrentDevice(): void {
  current = null
  boot = undefined
  failure = null
}
