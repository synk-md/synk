"use client"

import * as React from "react"
import {
  deviceFingerprint,
  getOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "@/lib/identity"

export type DeviceIdentityState = {
  identity: DeviceIdentity | null
  /** Short, human-comparable form of this device's key. */
  fingerprint: string | null
  loading: boolean
  error: Error | null
}

/**
 * This device's identity, generated on first run and stable thereafter.
 *
 * The private key never leaves the platform key store, so what this exposes is
 * the public half plus the handles needed to sign - never anything a component
 * could serialise by accident.
 */
export function useDeviceIdentity(): DeviceIdentityState {
  const [state, setState] = React.useState<DeviceIdentityState>({
    identity: null,
    fingerprint: null,
    loading: true,
    error: null,
  })

  React.useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const identity = await getOrCreateDeviceIdentity()
        const fingerprint = await deviceFingerprint(identity.did)
        if (!cancelled) setState({ identity, fingerprint, loading: false, error: null })
      } catch (cause) {
        if (cancelled) return
        setState({
          identity: null,
          fingerprint: null,
          loading: false,
          error: cause instanceof Error ? cause : new Error("Could not load this device's identity"),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return state
}

/** Resolve fingerprints for a set of device DIDs, for display in a list. */
export function useFingerprints(dids: readonly string[]): Record<string, string> {
  const [map, setMap] = React.useState<Record<string, string>>({})
  const key = dids.join("|")

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        key
          .split("|")
          .filter(Boolean)
          .map(async (did) => [did, await deviceFingerprint(did)] as const),
      )
      if (!cancelled) setMap(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [key])

  return map
}
