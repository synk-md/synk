"use client"

import * as React from "react"

import type { Notebook, TreeNode } from "@/components/custom-ui/file-browser/tree"
import { currentDevice } from "@/lib/identity"
import { fetchNotebook, followEverywhere, watchInbox } from "@/lib/workspace/device-pairing"
import { relayConnection } from "@/lib/workspace/note-relay"

const TAKEN_KEY = "synk:followed-notebooks"
const FOLLOW_EVERY_MS = 60 * 60 * 1000
const RETRY_EVERY_MS = 5 * 60 * 1000

// Notebooks an announcement already brought here, so one deleted on this
// device is not brought back.
function taken(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TAKEN_KEY) ?? "[]") as string[])
  } catch {
    return new Set()
  }
}

function markTaken(notebookId: string): void {
  try {
    localStorage.setItem(TAKEN_KEY, JSON.stringify([...taken(), notebookId]))
  } catch {
    // Without storage it may be offered again; nothing worse.
  }
}

/**
 * A person's devices follow one another: this device links the others into
 * notebooks it creates or joins, and takes in the ones they announce to it.
 */
export function useDeviceFollowing(
  notebooks: readonly Notebook[],
  adopt: (id: string, root: TreeNode, options?: { open?: boolean }) => void,
): void {
  const notebooksRef = React.useRef(notebooks)
  notebooksRef.current = notebooks
  const ids = notebooks.map((notebook) => notebook.id).sort().join(",")

  React.useEffect(() => {
    const device = currentDevice()
    if (!device || !relayConnection()) return
    const run = () => {
      const list = notebooksRef.current.map((notebook) => ({ id: notebook.id, name: notebook.name }))
      void followEverywhere({ device: device.identity, notebooks: list }).catch((error: unknown) => {
        console.warn("Could not bring your other devices along", error)
      })
    }
    // Shortly after a notebook arrives, so a new one is ready to share.
    const soon = setTimeout(run, 2000)
    const every = setInterval(run, FOLLOW_EVERY_MS)
    return () => {
      clearTimeout(soon)
      clearInterval(every)
    }
  }, [ids])

  React.useEffect(() => {
    const device = currentDevice()
    if (!device || !relayConnection()) return
    const watch = watchInbox({
      device: device.identity,
      notebookIds: () => notebooksRef.current.map((notebook) => notebook.id),
      onAnnouncements: async (announcements) => {
        const already = taken()
        for (const announcement of announcements) {
          const { notebookId } = announcement
          if (already.has(notebookId)) continue
          if (notebooksRef.current.some((notebook) => notebook.id === notebookId)) {
            markTaken(notebookId)
            continue
          }
          // Not ready yet - linked, but not all at the relay - is tried again later.
          const root = await fetchNotebook(notebookId, device.identity, announcement.owner).catch(() => null)
          if (!root) continue
          adopt(notebookId, root, { open: false })
          markTaken(notebookId)
        }
      },
    })
    const retry = setInterval(() => watch.check(), RETRY_EVERY_MS)
    return () => {
      clearInterval(retry)
      watch.close()
    }
  }, [adopt])
}
