import * as React from "react"
import { SimpleEditor } from "@/components/editor/editor"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useNotebooks } from "@/hooks/use-notebooks"
import { useNotebookFileSystem } from "@/components/custom-ui/file-browser/use-notebook-filesystem"
import { findNode, isNoteNode } from "@/components/custom-ui/file-browser/tree"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import { useBackgroundNoteSync } from "@/hooks/use-background-note-sync"
import { setLastOpenedNoteId } from "@/lib/notebook-settings"

function findFirstNoteId(root: TreeNode | null): string | undefined {
  if (!root) return undefined
  if (!root.isFolder) return isNoteNode(root) ? (root.id as string) : undefined

  for (const child of root.children ?? []) {
    const found = findFirstNoteId(child)
    if (found) return found
  }

  return undefined
}

export function NoteEditorPage({ notebookId, noteId }: { notebookId?: string; noteId?: string }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const params = useParams<{ notebookId: string; noteId: string }>()
  notebookId = notebookId || params.notebookId
  noteId = noteId || params.noteId

  // True when we're on `/nb/:notebookId` (no note segment)
  const isOriginRoute = !params.noteId
  const isEmptyEditorRoute = isOriginRoute && searchParams.get("empty") === "1"

  const { notebooks, updateNotebookRoot } = useNotebooks()

  const activeNotebook = React.useMemo(() => {
    if (!notebookId) return null
    return notebooks.find((nb) => nb.id === notebookId) ?? null
  }, [notebooks, notebookId])

  const noteExists = React.useMemo(() => {
    if (!activeNotebook || !noteId) return false
    const { node } = findNode(activeNotebook.root, noteId)
    return isNoteNode(node)
  }, [activeNotebook, noteId])

  const fallbackNoteId = React.useMemo(() => {
    if (!activeNotebook) return undefined
    return findFirstNoteId(activeNotebook.root)
  }, [activeNotebook])

  const effectiveNoteId = React.useMemo(() => {
    if (isEmptyEditorRoute) return undefined
    if (noteExists && noteId) return noteId
    return fallbackNoteId
  }, [isEmptyEditorRoute, noteExists, noteId, fallbackNoteId])

  const fileSystem = useNotebookFileSystem(activeNotebook, updateNotebookRoot)
  const rootNodeId = activeNotebook?.root.id ?? null
  const hasNotebookContext = Boolean(activeNotebook)

  // Without this, a collaborator's edits to a note the owner doesn't have
  // open only reach the owner's IndexedDB if the owner happens to open that
  // exact note while the collaborator is simultaneously online - P2P sync
  // has no one to relay through otherwise. This watches peers' awareness for
  // notes they have open and background-syncs those into IndexedDB so the
  // content isn't stuck stale/dirty until both sides view it at once.
  useBackgroundNoteSync(notebookId ?? "", effectiveNoteId ?? null, fileSystem.indexProvider ?? null)

  React.useEffect(() => {
    // No notebook id at all: always 404
    if (!notebookId) {
      navigate("/404", { replace: true })
      return
    }

    // Wait for notebooks to load before deciding anything
    if (!activeNotebook){
      navigate("/404", { replace: true })
      return
    }

    if (isOriginRoute) {
      if (isEmptyEditorRoute) return
      if (fallbackNoteId) {
        navigate(`/nb/${notebookId}/n/${fallbackNoteId}`, { replace: true })
      }
      return
    }

    if (!noteExists) {
      if (fallbackNoteId) {
        // Go straight to the fallback note
        navigate(`/nb/${notebookId}/n/${fallbackNoteId}`, { replace: true })
      } else {
        // No fallback note at all – just go to the notebook root
        navigate(`/nb/${notebookId}`, { replace: true })
      }
    }
  }, [navigate, notebookId, activeNotebook, isOriginRoute, isEmptyEditorRoute, noteId, noteExists, fallbackNoteId])

  // Mark this as last opened whenever it mounts or note changes
  React.useEffect(() => {
    // Only when we actually have a valid note
    if (!notebookId || !noteId || !noteExists) return

    setLastOpenedNoteId(notebookId, noteId)
  }, [notebookId, noteId, noteExists])

  const handleNavigateNote = React.useCallback((targetNoteId: string) => {
    if (!notebookId) return
    navigate(`/nb/${notebookId}/n/${targetNoteId}`)
  }, [navigate, notebookId])

  const handleCloseLastNote = React.useCallback(() => {
    if (!notebookId) return
    navigate(`/nb/${notebookId}?empty=1`)
  }, [navigate, notebookId])

  const handleNotebookCreated = React.useCallback((createdNotebookId: string, welcomeNoteId: string) => {
    navigate(`/nb/${createdNotebookId}/n/${welcomeNoteId}`)
  }, [navigate])

  // While notebooks are loading, render nothing (or a spinner if you want).
  if (!notebookId || !activeNotebook) {
    return null
  }

  // On `/nb/:notebookId/n/:noteId` with no note and no fallback (e.g. still loading)
  // avoid rendering while the effect decides where to go.
  // if (!isOriginRoute && !noteExists && !fallbackNoteId) {
  //   return null
  // }

  return (
    <SimpleEditor
      notebookId={notebookId}
      noteId={effectiveNoteId}
      fileSystem={fileSystem}
      rootNodeId={rootNodeId}
      hasNotebookContext={hasNotebookContext}
      onNavigateNote={handleNavigateNote}
      onCloseLastNote={handleCloseLastNote}
      onNotebookCreated={handleNotebookCreated}
      showNoteTabs
      // (title/theme props optional; your component can fetch from Yjs)
    />
  )
}
