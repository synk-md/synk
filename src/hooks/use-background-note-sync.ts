import * as React from "react"
import { WebrtcProvider } from "y-webrtc"
import { getOrCreateYDoc, SIGNALING_SERVERS } from "@/lib/yjs-utils"

type BackgroundSync = {
  provider: WebrtcProvider
  teardown: () => void
}

/**
 * Watches the notebook index provider's awareness for peers that are editing
 * a note the local user doesn't currently have open. For each such note a
 * short-lived background WebrtcProvider is created so the CRDT content syncs
 * into IndexedDB. When the peer stops editing (or disconnects) the provider
 * is torn down. No data is ever written to the persistent Y.Doc state — all
 * signalling is ephemeral via the awareness protocol.
 */
export function useBackgroundNoteSync(
  notebookId: string,
  currentNoteId: string | null,
  indexProvider: WebrtcProvider | null,
) {
  const currentNoteIdRef = React.useRef(currentNoteId)
  currentNoteIdRef.current = currentNoteId

  React.useEffect(() => {
    if (!indexProvider || !notebookId) return

    const backgroundProviders = new Map<string, BackgroundSync>()

    const sync = () => {
      const states = indexProvider.awareness.getStates()
      const myClientId = indexProvider.awareness.clientID

      const peerNoteIds = new Set<string>()
      for (const [clientId, state] of states) {
        if (clientId === myClientId) continue
        const noteId = (state as Record<string, unknown>)?.editingNoteId
        if (typeof noteId === "string" && noteId !== currentNoteIdRef.current) {
          peerNoteIds.add(noteId)
        }
      }

      // Tear down providers for notes no longer being edited by any peer
      for (const [noteId, { provider, teardown }] of backgroundProviders) {
        if (!peerNoteIds.has(noteId)) {
          teardown()
          provider.disconnect()
          provider.destroy()
          backgroundProviders.delete(noteId)
        }
      }

      // Start a background provider for each newly detected peer note
      for (const noteId of peerNoteIds) {
        if (backgroundProviders.has(noteId)) continue
        const { doc } = getOrCreateYDoc(notebookId, noteId)
        const room = `nb:${notebookId}:n:${noteId}`
        const provider = new WebrtcProvider(room, doc, {
          signaling: SIGNALING_SERVERS,
          password: room,
        })
        // Content that lands here still counts as a real sync of this note —
        // stamp it so the "last synced" indicator isn't stuck on whatever it
        // read from localStorage the last time the note was actually open,
        // once the user switches to it after the peer has moved on.
        const handleUpdate = (_update: Uint8Array, origin: unknown) => {
          if (origin === provider.room) {
            localStorage.setItem(`lastSyncedAt:${noteId}`, String(Date.now()))
          }
        }
        doc.on("update", handleUpdate)
        backgroundProviders.set(noteId, { provider, teardown: () => doc.off("update", handleUpdate) })
      }
    }

    indexProvider.awareness.on("change", sync)
    sync()

    return () => {
      indexProvider.awareness.off("change", sync)
      for (const { provider, teardown } of backgroundProviders.values()) {
        teardown()
        provider.disconnect()
        provider.destroy()
      }
    }
  }, [notebookId, indexProvider])
}
