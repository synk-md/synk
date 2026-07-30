import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { SimpleEditor } from "@/components/editor/editor"
import { useNotebookFileSystem } from "@/components/custom-ui/file-browser/use-notebook-filesystem"
import type { Notebook, TreeNode } from "@/components/custom-ui/file-browser/tree"
import { useNotebooks, NotebooksContext, type NotebooksCtx } from "@/hooks/use-notebooks"
import { resolveNotebookTargetNote } from "@/lib/resolve-notebook-target"
import { useBackgroundNoteSync } from "@/hooks/use-background-note-sync"

const emptyRoot = (notebookId: string): TreeNode => ({
  id: `shared-root-${notebookId}`,
  name: "Shared Notebook",
  isFolder: true,
  expanded: true,
  children: [],
})

export function SharedNotebookPage() {
  const { notebookId } = useParams<{ notebookId: string }>()
  const navigate = useNavigate()

  const [sharedRoot, setSharedRoot] = React.useState<TreeNode | null>(null)
  const [activeNoteId, setActiveNoteId] = React.useState<string | null>(null)

  const sharedNotebook = React.useMemo<Notebook | null>(() => {
    if (!notebookId) return null
    return {
      id: notebookId,
      name: sharedRoot?.name || "Shared Notebook",
      root: sharedRoot ?? emptyRoot(notebookId),
      createdAt: 0,
    }
  }, [notebookId, sharedRoot])

  const handleSharedRootChange = React.useCallback(
    (_: unknown, root: TreeNode) => {
      setSharedRoot(prev => (prev === root ? prev : root))
    },
    [],
  )

  // Passed to SimpleEditor as-is (not destructured apart) so its own
  // notebook-level link-access sync effect can see fs.linkAccess too.
  const notebookFileSystem = useNotebookFileSystem(sharedNotebook, handleSharedRootChange, {
    optimisticLinkAccess: "edit",
    // This page's "root" is a synthetic empty stub until the real tree
    // arrives — seeding the shared doc with it early would race the real
    // tree over WebRTC and can wipe the owner's notebook. Wait for either
    // real data or the grace window instead (see hook for details).
    seedIfEmpty: false,
  })
  const { linkAccess, treeReady, indexProvider } = notebookFileSystem

  useBackgroundNoteSync(notebookId ?? "", activeNoteId, indexProvider ?? null)

  const isRestricted = linkAccess === "restricted"
  const isViewOnly = linkAccess === "view"
  const allowFileCreation = linkAccess === "edit" && treeReady

  // Once the real tree has synced in, pick an initial note to open (last
  // opened, else the first one in the tree) — reuses the same resolver the
  // local editor's `/nb/:notebookId` origin route would eventually use.
  React.useEffect(() => {
    if (!notebookId || activeNoteId || isRestricted) return
    let cancelled = false
    resolveNotebookTargetNote(notebookId, sharedRoot).then(id => {
      if (!cancelled && id) setActiveNoteId(id)
    })
    return () => {
      cancelled = true
    }
  }, [notebookId, activeNoteId, isRestricted, sharedRoot])

  const handleNavigateNote = React.useCallback((targetNoteId: string) => {
    setActiveNoteId(targetNoteId)
  }, [])

  // SimpleEditor's own per-note permission model only trusts a note's own
  // link-access metadata (built for sharing one note at a time), so it
  // would otherwise stay stuck at "view only" for notes that were never
  // individually shared. SimpleEditor's own notebook-level sync effect
  // (keyed off fs.linkAccess) handles stamping every "inherited" note in
  // the tree to match, including the one currently open, so nothing extra
  // is needed here.

  const realNotebooks = useNotebooks()

  const notebooksCtxValue = React.useMemo<NotebooksCtx>(() => ({
    ...realNotebooks,
    currentNotebook: sharedNotebook,
    currentId: sharedNotebook?.id ?? null,
  }), [realNotebooks, sharedNotebook])

  const handleNotebookCreated = React.useCallback((createdNotebookId: string, welcomeNoteId: string) => {
    navigate(`/nb/${createdNotebookId}/n/${welcomeNoteId}`)
  }, [navigate])

  React.useEffect(() => {
    if (!notebookId) {
      navigate("/404", { replace: true })
    }
  }, [navigate, notebookId])

  if (!notebookId || !sharedNotebook) {
    return null
  }

  if (isRestricted) {
    return (
      <main className="not-found">
        <section className="not-found__card">
          <p className="not-found__eyebrow">Link sharing is off</p>
          <h1>This notebook is no longer shared</h1>
          <p className="not-found__description">
            The owner has turned off link sharing for this notebook, or it was never shared.
          </p>
          <div className="not-found__actions">
            <Link to="/" className="not-found__button not-found__button--ghost">
              Return to Home
            </Link>
          </div>
        </section>
      </main>
    )
  }

  return (
    <NotebooksContext.Provider value={notebooksCtxValue}>
      <SimpleEditor
        notebookId={notebookId}
        noteId={activeNoteId ?? undefined}
        fileSystem={notebookFileSystem}
        rootNodeId={sharedNotebook.root.id}
        hasNotebookContext={true}
        onNavigateNote={handleNavigateNote}
        onNotebookCreated={handleNotebookCreated}
        allowFileCreation={allowFileCreation}
        initialLinkAccess={isViewOnly ? "view" : "edit"}
        showNoteTabs
        isSharedView
        showFileBrowser
      />
    </NotebooksContext.Provider>
  )
}
