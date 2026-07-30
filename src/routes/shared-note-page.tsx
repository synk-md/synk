import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { SimpleEditor } from "@/components/editor/editor"
import { useNotebookFileSystem } from "@/components/custom-ui/file-browser/use-notebook-filesystem"
import type { NotebookFileSystemApi } from "@/components/custom-ui/file-browser/use-notebook-filesystem"
import { useFileSystem } from "@/components/custom-ui/file-browser/use-file-system"
import type { Notebook, TreeNode } from "@/components/custom-ui/file-browser/tree"
import { findNode } from "@/components/custom-ui/file-browser/tree"
import { NotebooksContext, type NotebooksCtx } from "@/hooks/use-notebooks"

export function SharedNotePage() {
  const { notebookId, noteId } = useParams<{ notebookId: string; noteId: string }>()
  const navigate = useNavigate()

  const [sharedRoot, setSharedRoot] = React.useState<TreeNode | null>(null)
  const [singleNoteName, setSingleNoteName] = React.useState("Untitled note")

  const lastTitleRef = React.useRef(singleNoteName)

  const singleNoteRoot = React.useMemo<TreeNode>(
    () => ({
      id: notebookId ? `shared-root-${notebookId}` : "__shared__",
      name: "Shared Notebook",
      isFolder: true,
      expanded: true,
      children: noteId
        ? [
            {
              id: noteId,
              name: singleNoteName,
              isFolder: false,
            },
          ]
        : [],
    }),
    [notebookId, noteId, singleNoteName],
  )

  const sharedNotebook = React.useMemo<Notebook | null>(() => {
    if (!notebookId) return null
    return {
      id: notebookId,
      name: "Shared Notebook",
      root: sharedRoot ?? singleNoteRoot,
      createdAt: 0,
    }
  }, [notebookId, sharedRoot, singleNoteRoot])

  // 1) Guard sharedRoot updates to avoid root-based render loops
  const handleSharedRootChange = React.useCallback(
    (_: unknown, root: TreeNode) => {
      setSharedRoot(prev => (prev === root ? prev : root))
    },
    [],
  )

  const notebookFileSystem = useNotebookFileSystem(sharedNotebook, handleSharedRootChange)
  const singleNoteFileSystem = useFileSystem({ root: singleNoteRoot })

  const sharedTreeContainsNote = React.useMemo(() => {
    if (!sharedRoot || !noteId) return false
    return Boolean(findNode(sharedRoot, noteId).node)
  }, [sharedRoot, noteId])

  const activeFileSystem: NotebookFileSystemApi = sharedTreeContainsNote
    ? notebookFileSystem
    : singleNoteFileSystem

  const activeRoot = sharedTreeContainsNote && sharedRoot ? sharedRoot : singleNoteRoot
  const activeNotebook = sharedNotebook ? { ...sharedNotebook, root: activeRoot } : null
  const allowFileCreation = sharedTreeContainsNote

  // 2) Only mirror titles into local state while we're in "single note" mode,
  //    and only rename in the shared FS when the note is actually there.
  const handleTitleChange = React.useCallback(
    (title: string) => {
      if (!notebookId || !noteId) return

      const trimmed = title?.trim()
      const nextName = trimmed && trimmed.length > 0 ? trimmed : "Untitled note"

      if (nextName === lastTitleRef.current) return
      lastTitleRef.current = nextName

      if (sharedTreeContainsNote) {
        // Shared tree is loaded: let the real notebook FS own the name.
        notebookFileSystem.rename(noteId, nextName)
      } else {
        // Still in fallback single-note mode: keep the stub in sync.
        setSingleNoteName(nextName)
      }
    },
    [notebookFileSystem, notebookId, noteId, sharedTreeContainsNote],
  )

  React.useEffect(() => {
    lastTitleRef.current = singleNoteName
  }, [singleNoteName])

  React.useEffect(() => {
    if (!notebookId || !noteId) {
      navigate("/404", { replace: true })
    }
  }, [navigate, notebookId, noteId])

  const handleNavigateNote = React.useCallback(
    (targetNoteId: string) => {
      if (!notebookId) return
      navigate(`/s/${notebookId}/${targetNoteId}`)
    },
    [navigate, notebookId],
  )

  const notebooksCtxValue = React.useMemo<NotebooksCtx>(
    () => ({
      notebooks: activeNotebook ? [activeNotebook] : [],
      currentNotebook: activeNotebook,
      currentId: activeNotebook?.id ?? null,
      createNotebook: async () => {
        throw new Error("Cannot create notebooks from a shared note view")
      },
      importNotebook: async () => {
        throw new Error("Cannot import notebooks from a shared note view")
      },
      setCurrent: () => {},
      updateNotebookRoot: () => {},
      renameNotebook: () => {},
      deleteNotebook: async () => {},
    }),
    [activeNotebook],
  )

  if (!notebookId || !noteId || !sharedNotebook) {
    return null
  }

  return (
    <NotebooksContext.Provider value={notebooksCtxValue}>
      <SimpleEditor
        notebookId={notebookId}
        noteId={noteId}
        onTitleChange={handleTitleChange}
        fileSystem={activeFileSystem}
        rootNodeId={activeRoot.id}
        hasNotebookContext={true}
        onNavigateNote={handleNavigateNote}
        showNotebookLockIndicator={false}
        allowFileCreation={allowFileCreation}
        initialLinkAccess="edit"
        isSharedView
      />
    </NotebooksContext.Provider>
  )
}
