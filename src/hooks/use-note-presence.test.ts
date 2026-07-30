import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useNotePresence } from "./use-note-presence"
import type { WebrtcProvider } from "y-webrtc"

type AwarenessState = Record<string, unknown>

// Minimal stand-in for y-protocols' Awareness: getStates()/clientID plus the
// on/off("change", ...) pub-sub the hook relies on. Only what the hook touches.
function createFakeProvider(clientID: number) {
  const states = new Map<number, AwarenessState>()
  const listeners = new Set<() => void>()

  const awareness = {
    clientID,
    getStates: () => states,
    on: (event: string, cb: () => void) => {
      if (event === "change") listeners.add(cb)
    },
    off: (event: string, cb: () => void) => {
      if (event === "change") listeners.delete(cb)
    },
  }

  const setState = (id: number, state: AwarenessState) => {
    states.set(id, state)
    listeners.forEach((cb) => cb())
  }

  return { awareness, setState, provider: { awareness } as unknown as WebrtcProvider }
}

describe("useNotePresence", () => {
  it("returns an empty map when there is no index provider", () => {
    const { result } = renderHook(() => useNotePresence(null))
    expect(result.current.size).toBe(0)
  })

  it("groups peers by the note they're editing", () => {
    const { provider, setState } = createFakeProvider(1)

    const { result } = renderHook(() => useNotePresence(provider))

    act(() => {
      setState(2, { editingNoteId: "note-a", user: { name: "Alice", color: "red" } })
      setState(3, { editingNoteId: "note-a", user: { name: "Bob" } })
      setState(4, { editingNoteId: "note-b", user: { name: "Cara" } })
    })

    expect(result.current.get("note-a")).toEqual([
      { name: "Alice", color: "red" },
      { name: "Bob", color: undefined },
    ])
    expect(result.current.get("note-b")).toEqual([{ name: "Cara", color: undefined }])
  })

  it("excludes the local client's own awareness state", () => {
    const { provider, setState } = createFakeProvider(1)

    const { result } = renderHook(() => useNotePresence(provider))

    act(() => {
      setState(1, { editingNoteId: "note-a", user: { name: "Me" } })
    })

    expect(result.current.size).toBe(0)
  })

  it("ignores peers with no editingNoteId and defaults an unnamed user", () => {
    const { provider, setState } = createFakeProvider(1)

    const { result } = renderHook(() => useNotePresence(provider))

    act(() => {
      setState(2, { user: { name: "Idle" } })
      setState(3, { editingNoteId: "note-a" })
    })

    expect(result.current.size).toBe(1)
    expect(result.current.get("note-a")).toEqual([{ name: "Anonymous", color: undefined }])
  })

  it("resets to an empty map when the provider becomes null", () => {
    const { provider, setState } = createFakeProvider(1)
    const { result, rerender } = renderHook(
      ({ p }: { p: WebrtcProvider | null }) => useNotePresence(p),
      { initialProps: { p: provider as WebrtcProvider | null } },
    )

    act(() => {
      setState(2, { editingNoteId: "note-a", user: { name: "Alice" } })
    })
    expect(result.current.size).toBe(1)

    rerender({ p: null })
    expect(result.current.size).toBe(0)
  })
})
