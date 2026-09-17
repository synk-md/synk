"use client"

/*
Shared notebooks state (Context + Provider).
Keeps a list of notebooks and which one is active. Persists to localStorage.
*/

import * as React from "react"
import {
  deleteNoteFromIndexedDB,
  deleteNotebookMetaFromIndexedDB,
  evictNotebookIndexDoc,
  newNoteId,
  newNotebookId,
} from "@/lib/yjs-utils"
import { collectLeaves, type TreeNode, type Notebook, type NotebooksState } from "@/components/custom-ui/file-browser/tree"
import { seedWelcomeNote } from "@/lib/seed-welcome-note"
import { forgetLastOpenedNoteId, setLastOpenedNoteId } from "@/lib/notebook-settings"
import { deleteImageAsset } from "@/lib/image-assets"
import { importNotebookArchive } from "@/lib/notebook-import"

const LS_KEY = "notebooks:v1"

function load(): NotebooksState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : { notebooks: [], currentId: null }
  } catch {
    return { notebooks: [], currentId: null }
  }
}

function save(state: NotebooksState) {
  localStorage.setItem(LS_KEY, JSON.stringify(state))
}

// Notebook names are compared trimmed + case-insensitively so "Travel" and
// " travel " are treated as the same name.
function normalizeName(name: string) {
  return name.trim().toLowerCase()
}

function isNameTaken(notebooks: Notebook[], name: string, excludeId?: string) {
  const normalized = normalizeName(name)
  return notebooks.some(nb => nb.id !== excludeId && normalizeName(nb.name) === normalized)
}

/** Appends " (2)", " (3)", etc. until the name no longer collides. Used for
 *  imports, where blocking on a name collision would be surprising. */
function uniqueName(notebooks: Notebook[], name: string) {
  const base = name.trim() || "Untitled Notebook"
  if (!isNameTaken(notebooks, base)) return base

  let n = 2
  while (isNameTaken(notebooks, `${base} (${n})`)) n++
  return `${base} (${n})`
}

type CreateNotebookResult = { notebookId: string; welcomeNoteId: string }

export type NotebooksCtx = {
  notebooks: Notebook[]
  currentNotebook: Notebook | null
  currentId: string | null
  createNotebook: (name: string) => Promise<CreateNotebookResult>
  importNotebook: (file: File) => Promise<Notebook>
  setCurrent: (id: string | null) => void,
  updateNotebookRoot: (id: string, root: TreeNode) => void
  renameNotebook: (id: string, name: string) => void
  deleteNotebook: (id: string) => Promise<void>
}

const Ctx = React.createContext<NotebooksCtx | null>(null)
export const NotebooksContext = Ctx

export function NotebooksProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<NotebooksState>(() => load())

  // Saves the new state to localStorage after applying the updater.
  const persist = React.useCallback((updater: (s: NotebooksState) => NotebooksState) => {
    setState(prev => {
      const next = updater(prev)
      save(next)
      return next
    })
  }, [])

  // Creates a new notebook with a welcome note, sets it as current, and persists to localStorage.
  const createNotebook = React.useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (isNameTaken(state.notebooks, trimmed)) {
      throw new Error(`A notebook named "${trimmed}" already exists.`)
    }

    const nb_id = `${newNotebookId()}`
    const welcomeId = `${newNoteId()}`
    const root: TreeNode = {
      id: `root_${nb_id}`,
      name: trimmed || "Untitled Notebook", // used as hidden root label
      isFolder: true,
      expanded: true,
      children: [{ id: welcomeId, name: "Welcome", isFolder: false }],
    }
    const nb: Notebook = { id: nb_id, name: trimmed || "Untitled Notebook", root, createdAt: Date.now() }

    persist(s => ({ notebooks: [nb, ...s.notebooks], currentId: nb_id }))

    // Seed the welcome note's Y.Doc with initial content + meta
    await seedWelcomeNote(nb_id, welcomeId)

    setLastOpenedNoteId(nb_id, welcomeId)

    return { notebookId: nb_id, welcomeNoteId: welcomeId }
  }, [persist, state.notebooks])

  // Rebuilds a notebook (tree, note content, image assets) from a .zip
  // produced by exportNotebookArchive, registers it as a new notebook, and
  // persists it to localStorage. The imported name is de-duplicated rather
  // than rejected outright, since the name comes from the archive, not
  // something the user is actively typing.
  const importNotebook = React.useCallback(async (file: File) => {
    const nb_id = `${newNotebookId()}`
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { name: rawName, root: importedRoot } = await importNotebookArchive(bytes, nb_id)
    const name = uniqueName(state.notebooks, rawName)
    const root: TreeNode = { ...importedRoot, name }
    const nb: Notebook = { id: nb_id, name, root, createdAt: Date.now() }

    persist(s => ({ notebooks: [nb, ...s.notebooks], currentId: nb_id }))

    return nb
  }, [persist, state.notebooks])

  // Sets the current notebook by ID.
  const setCurrent = React.useCallback((id: string | null) => {
    persist(s => ({ ...s, currentId: id }))
  }, [persist])

  const updateNotebookRoot = React.useCallback((id: string, root: TreeNode) => {
    persist(s => ({
      ...s,
      notebooks: s.notebooks.map(nb => (nb.id === id ? { ...nb, root } : nb)),
    }))
  }, [persist])

  // Renames a notebook in place. Keeps root.name in sync since it doubles as
  // the (hidden) root label for the file tree.
  const renameNotebook = React.useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (isNameTaken(state.notebooks, trimmed, id)) {
      throw new Error(`A notebook named "${trimmed}" already exists.`)
    }
    persist(s => ({
      ...s,
      notebooks: s.notebooks.map(nb =>
        nb.id === id ? { ...nb, name: trimmed, root: { ...nb.root, name: trimmed } } : nb
      ),
    }))
  }, [persist, state.notebooks])

  // Removes a notebook and tears down its underlying storage: every note's
  // Y.Doc, any image assets, and the notebook's own index doc.
  const deleteNotebook = React.useCallback(async (id: string) => {
    const target = state.notebooks.find(nb => nb.id === id)
    if (!target) return

    persist(s => {
      const remaining = s.notebooks.filter(nb => nb.id !== id)
      const currentId = s.currentId === id ? (remaining[0]?.id ?? null) : s.currentId
      return { notebooks: remaining, currentId }
    })

    const { noteIds, assetIds } = collectLeaves(target.root)
    evictNotebookIndexDoc(id)
    forgetLastOpenedNoteId(id)

    await Promise.all([
      ...noteIds.map(noteId =>
        deleteNoteFromIndexedDB(id, noteId).catch(err =>
          console.error("Error deleting note from IndexedDB:", err)
        )
      ),
      ...assetIds.map(assetId =>
        deleteImageAsset(assetId).catch(err =>
          console.error("Error deleting image asset:", err)
        )
      ),
      deleteNotebookMetaFromIndexedDB(id).catch(err =>
        console.error("Error deleting notebook meta from IndexedDB:", err)
      ),
    ])
  }, [state.notebooks, persist])

  const currentNotebook = state.notebooks.find(n => n.id === state.currentId) || null

  const value = React.useMemo<NotebooksCtx>(() => ({
    notebooks: state.notebooks,
    currentNotebook,
    currentId: state.currentId,
    createNotebook,
    importNotebook,
    setCurrent,
    updateNotebookRoot,
    renameNotebook,
    deleteNotebook,
  }), [state.notebooks, currentNotebook, state.currentId, createNotebook, importNotebook, setCurrent, updateNotebookRoot, renameNotebook, deleteNotebook])

  return React.createElement(Ctx.Provider, { value }, children)
}

/** Use this hook anywhere *inside* <NotebooksProvider>. and access functions and states in NotebooksCtx. */
export function useNotebooks() {
  const ctx = React.useContext(Ctx)
  if (!ctx) {
    throw new Error("useNotebooks must be used within <NotebooksProvider>")
  }
  return ctx
}
