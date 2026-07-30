import * as React from "react"
import { WebrtcProvider } from "y-webrtc"

export type NotePresenceUser = { name: string; color?: string }
/** noteId → list of peers currently viewing that note */
export type NotePresenceMap = Map<string, NotePresenceUser[]>

export function useNotePresence(indexProvider: WebrtcProvider | null): NotePresenceMap {
  const [presence, setPresence] = React.useState<NotePresenceMap>(new Map())

  React.useEffect(() => {
    if (!indexProvider) {
      setPresence(new Map())
      return
    }

    const compute = () => {
      const states = indexProvider.awareness.getStates()
      const myClientId = indexProvider.awareness.clientID
      const next = new Map<string, NotePresenceUser[]>()

      for (const [clientId, state] of states) {
        if (clientId === myClientId) continue
        const s = state as Record<string, unknown>
        const noteId = s?.editingNoteId
        if (typeof noteId !== "string" || !noteId) continue
        const u = s?.user as { name?: string; color?: string } | undefined
        const user: NotePresenceUser = { name: u?.name ?? "Anonymous", color: u?.color }
        const list = next.get(noteId) ?? []
        list.push(user)
        next.set(noteId, list)
      }
      setPresence(next)
    }

    indexProvider.awareness.on("change", compute)
    compute()

    return () => {
      indexProvider.awareness.off("change", compute)
      setPresence(new Map())
    }
  }, [indexProvider])

  return presence
}
