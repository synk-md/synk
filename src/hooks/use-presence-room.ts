"use client"

import * as React from "react"

import type { ReadKeySource } from "@/lib/keys"
import { presenceRoom, type PresenceRoom } from "@/lib/workspace"

/**
 * The presence room for the current epoch, or null without a key to derive it.
 *
 * Recomputed when the epoch moves, not on every re-read of the keys - the
 * keyring object is new each time the directory changes.
 */
export function usePresenceRoom(keyring: ReadKeySource | null, scope: string | null): PresenceRoom | null {
  const [room, setRoom] = React.useState<PresenceRoom | null>(null)
  const keyringRef = React.useRef(keyring)
  keyringRef.current = keyring
  const epoch = keyring?.currentEpoch ?? null

  React.useEffect(() => {
    const source = keyringRef.current
    if (epoch === null || !scope || !source) {
      setRoom(null)
      return
    }
    let cancelled = false
    void source
      .keyFor(epoch)
      .then((key) => (key ? presenceRoom(key, scope) : null))
      .then((next) => {
        if (!cancelled) setRoom((previous) => (previous?.name === next?.name ? previous : next))
      })
    return () => {
      cancelled = true
    }
  }, [epoch, scope])

  return room
}
