import * as React from "react"

/**
 * One visited "place" inside the editor column: a note, an asset preview or
 * a virtual "New tab" pill.
 */
export type ViewHistoryEntry =
  | { kind: "note"; id: string }
  | { kind: "preview"; id: string }
  | { kind: "newTab"; id: string }

const MAX_HISTORY = 100

export function sameEntry(a: ViewHistoryEntry | null, b: ViewHistoryEntry | null) {
  if (!a || !b) return a === b
  return a.kind === b.kind && a.id === b.id
}

type UseViewHistoryOptions = {
  /** The place currently shown in the editor, or null when nothing is. */
  current: ViewHistoryEntry | null
  /** False for entries that no longer exist (deleted note, closed new tab). */
  isEntryValid: (entry: ViewHistoryEntry) => boolean
  /** Actually show an entry again. Must not call `record`. */
  navigate: (entry: ViewHistoryEntry) => void
}

/**
 * Browser-style back/forward over the editor's active view.
 *
 * Navigations record themselves: every handler that swaps what the editor
 * shows calls `record(target)` first, which pushes the place being left onto
 * the back stack and drops the forward stack. `goBack`/`goForward` move
 * between them without recording, skipping entries that have since become
 * invalid.
 */
export function useViewHistory({ current, isEntryValid, navigate }: UseViewHistoryOptions) {
  const [back, setBack] = React.useState<ViewHistoryEntry[]>([])
  const [forward, setForward] = React.useState<ViewHistoryEntry[]>([])

  // Kept in refs so the returned callbacks stay stable across renders - they
  // end up in the deps of most navigation handlers in the editor.
  const currentRef = React.useRef(current)
  currentRef.current = current
  const isEntryValidRef = React.useRef(isEntryValid)
  isEntryValidRef.current = isEntryValid
  const navigateRef = React.useRef(navigate)
  navigateRef.current = navigate

  const record = React.useCallback((target: ViewHistoryEntry | null) => {
    const from = currentRef.current
    if (!from) return
    if (sameEntry(from, target)) return

    setBack((stack) => {
      if (sameEntry(stack[stack.length - 1] ?? null, from)) return stack
      return [...stack, from].slice(-MAX_HISTORY)
    })
    setForward((stack) => (stack.length ? [] : stack))
  }, [])

  const reset = React.useCallback(() => {
    setBack([])
    setForward([])
  }, [])

  const step = React.useCallback(
    (direction: "back" | "forward") => {
      const from = direction === "back" ? back : forward
      const setFrom = direction === "back" ? setBack : setForward
      const setTo = direction === "back" ? setForward : setBack

      // Drop anything that pointed at a note or tab that's since gone.
      let index = from.length - 1
      while (index >= 0 && !isEntryValidRef.current(from[index])) index -= 1
      if (index < 0) {
        setFrom([])
        return
      }

      const target = from[index]
      const leaving = currentRef.current

      setFrom(from.slice(0, index))
      if (leaving && !sameEntry(leaving, target)) {
        setTo((stack) => [...stack, leaving].slice(-MAX_HISTORY))
      }

      navigateRef.current(target)
    },
    [back, forward],
  )

  const goBack = React.useCallback(() => step("back"), [step])
  const goForward = React.useCallback(() => step("forward"), [step])

  const canGoBack = back.some((entry) => isEntryValid(entry))
  const canGoForward = forward.some((entry) => isEntryValid(entry))

  return { record, reset, goBack, goForward, canGoBack, canGoForward }
}
