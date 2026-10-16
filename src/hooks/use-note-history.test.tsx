import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import type * as Y from "yjs"

import type { CadencePolicy } from "@/lib/history"
import { currentDevice, initCurrentDevice, resetCurrentDevice, resetDeviceIdentityCache } from "@/lib/identity"
import { foundNotebookKeys, foundNotebookWorkspace } from "@/lib/workspace"
import { createNotebookIndexDoc, getOrCreateYDoc } from "@/lib/yjs-utils"

import { useNoteHistory } from "./use-note-history"

let NOTEBOOK = "history"
let counter = 0

beforeEach(async () => {
  counter += 1
  NOTEBOOK = `history-${String(counter)}-${String(Date.now())}`
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
  const device = currentDevice()!
  const { doc, idb } = createNotebookIndexDoc(NOTEBOOK)
  await idb.whenSynced
  await foundNotebookWorkspace({ doc, notebookId: NOTEBOOK, device: device.identity, label: "Maren" })
  await foundNotebookKeys({ doc, notebookId: NOTEBOOK, device: device.identity })
})

/** Checks every few ms instead of every 30 s. */
const CHECK = 20
/** An anchor at the first change, so a test need not type two thousand of them. */
const EAGER: CadencePolicy = { everyUpdates: 1, everyMs: 60_000, minIntervalMs: 0 }

async function mounted({ canAuthor = true, shared = true } = {}) {
  const { doc, idb } = getOrCreateYDoc(NOTEBOOK, "kyoto")
  await idb.whenSynced
  const hook = renderHook(() =>
    useNoteHistory({ notebookId: NOTEBOOK, noteId: "kyoto", doc, canAuthor, shared, checkEveryMs: CHECK, cadence: EAGER }),
  )
  await waitFor(() => expect(hook.result.current.readable).toBe(true))
  return { ...hook, doc }
}

const edit = (doc: Y.Doc, text: string) => doc.transact(() => doc.getText("body").insert(0, text))
const pointsOf = async (result: { current: ReturnType<typeof useNoteHistory> }) =>
  (await result.current.history!.list()).length

describe("a shared note", () => {
  it("takes an anchor as it is edited", async () => {
    const { result, doc } = await mounted()
    edit(doc, "Something new.")

    await waitFor(async () => expect(await pointsOf(result)).toBe(1))
  })

  it("takes none while nothing changes", async () => {
    const { result } = await mounted()
    await new Promise((resolve) => setTimeout(resolve, CHECK * 6))

    expect(await pointsOf(result)).toBe(0)
  })

  /** Two tabs on one note would otherwise take two of every anchor. */
  it("takes none in a tab that is not the one writing", async () => {
    const { result, doc } = await mounted({ canAuthor: false })
    edit(doc, "Typed elsewhere, arriving here.")
    await new Promise((resolve) => setTimeout(resolve, CHECK * 6))

    expect(await pointsOf(result)).toBe(0)
  })
})

/** A note nobody else uses keeps only what someone chose to keep. */
describe("a note kept to oneself", () => {
  it("takes nothing on its own while it is edited", async () => {
    const { result, doc } = await mounted({ shared: false })
    edit(doc, "Something new.")
    await new Promise((resolve) => setTimeout(resolve, CHECK * 6))

    expect(await pointsOf(result)).toBe(0)
  })

  it("takes nothing on leaving it", async () => {
    const { result, doc, unmount } = await mounted({ shared: false })
    const history = result.current.history!
    edit(doc, "Written just before leaving.")
    unmount()
    await new Promise((resolve) => setTimeout(resolve, CHECK * 6))

    expect((await history.list()).length).toBe(0)
  })

  it("lists a checkpoint saved by hand", async () => {
    const { result, doc } = await mounted({ shared: false })
    edit(doc, "Worth keeping.")
    await result.current.history!.take("checkpoint", "Draft")
    await result.current.refresh()

    await waitFor(() => expect(result.current.points.map((point) => point.label)).toEqual(["Draft"]))
  })
})
