import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import * as Y from "yjs"
import { useBackgroundNoteSync } from "./use-background-note-sync"
import type { WebrtcProvider } from "y-webrtc"

// Stand-in for y-webrtc's WebrtcProvider: no real networking, just records
// construction and exposes disconnect/destroy spies plus a stable `room`
// identity object (the hook compares Y.Doc update `origin` against it).
// Defined inside vi.hoisted since vi.mock factories run before normal
// top-level declarations.
const { providerInstances, docsByKey, FakeWebrtcProvider } = vi.hoisted(() => {
  class FakeWebrtcProvider {
    room = {}
    disconnect = vi.fn()
    destroy = vi.fn()
    roomName: string
    doc: Y.Doc
    opts: unknown
    constructor(roomName: string, doc: Y.Doc, opts: unknown) {
      this.roomName = roomName
      this.doc = doc
      this.opts = opts
      providerInstances.push(this)
    }
  }
  const providerInstances: InstanceType<typeof FakeWebrtcProvider>[] = []
  const docsByKey = new Map<string, Y.Doc>()
  return { providerInstances, docsByKey, FakeWebrtcProvider }
})

vi.mock("y-webrtc", () => ({
  WebrtcProvider: FakeWebrtcProvider,
}))

vi.mock("@/lib/yjs-utils", () => ({
  getOrCreateYDoc: (notebookId: string, noteId: string) => {
    const key = `${notebookId}:${noteId}`
    let doc = docsByKey.get(key)
    if (!doc) {
      doc = new Y.Doc()
      docsByKey.set(key, doc)
    }
    return { doc }
  },
  SIGNALING_SERVERS: ["wss://fake-signaling.test"],
}))

// Y.Doc's "update" event is typed with its full internal signature
// (update, origin, doc, transaction); tests only care about the first two.
function emitUpdate(doc: Y.Doc, origin: unknown) {
  ;(doc.emit as (name: string, args: unknown[]) => void)("update", [new Uint8Array(), origin])
}

type AwarenessState = Record<string, unknown>

function createFakeIndexProvider(clientID: number) {
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

  const deleteState = (id: number) => {
    states.delete(id)
    listeners.forEach((cb) => cb())
  }

  return {
    setState,
    deleteState,
    provider: { awareness } as unknown as WebrtcProvider,
  }
}

beforeEach(() => {
  providerInstances.length = 0
  docsByKey.clear()
  localStorage.clear()
})

describe("useBackgroundNoteSync", () => {
  it("starts a background provider for a note a peer is editing", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })

    expect(providerInstances).toHaveLength(1)
    expect(providerInstances[0].roomName).toBe("nb:nb1:n:note-a")
  })

  it("ignores the local client's own awareness state", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(1, { editingNoteId: "note-a" })
    })

    expect(providerInstances).toHaveLength(0)
  })

  it("does not start a background provider for the note currently open locally", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", "note-a", provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })

    expect(providerInstances).toHaveLength(0)
  })

  it("tears down the provider once no peer is editing that note anymore", () => {
    const { provider, setState, deleteState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })
    const bg = providerInstances[0]

    act(() => {
      deleteState(2)
    })

    expect(bg.disconnect).toHaveBeenCalledTimes(1)
    expect(bg.destroy).toHaveBeenCalledTimes(1)
  })

  it("does not create duplicate providers for a note already being synced", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })
    act(() => {
      setState(3, { editingNoteId: "note-a" })
    })

    expect(providerInstances).toHaveLength(1)
  })

  it("stamps lastSyncedAt in localStorage when an update originates from the background room", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })
    const bg = providerInstances[0]

    act(() => {
      emitUpdate(bg.doc, bg.room)
    })

    expect(localStorage.getItem("lastSyncedAt:note-a")).not.toBeNull()
  })

  it("does not stamp lastSyncedAt for updates from an unrelated origin", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
    })
    const bg = providerInstances[0]

    act(() => {
      emitUpdate(bg.doc, "some-other-origin")
    })

    expect(localStorage.getItem("lastSyncedAt:note-a")).toBeNull()
  })

  it("tears down all providers on unmount", () => {
    const { provider, setState } = createFakeIndexProvider(1)

    const { unmount } = renderHook(() => useBackgroundNoteSync("nb1", null, provider))

    act(() => {
      setState(2, { editingNoteId: "note-a" })
      setState(3, { editingNoteId: "note-b" })
    })
    expect(providerInstances).toHaveLength(2)

    unmount()

    for (const bg of providerInstances) {
      expect(bg.disconnect).toHaveBeenCalledTimes(1)
      expect(bg.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it("does nothing when there is no index provider", () => {
    renderHook(() => useBackgroundNoteSync("nb1", null, null))
    expect(providerInstances).toHaveLength(0)
  })
})
