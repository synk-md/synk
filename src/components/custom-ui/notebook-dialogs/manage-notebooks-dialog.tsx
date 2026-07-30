"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import { RiAddLine, RiBookShelfLine, RiCloseLine, RiUploadLine } from "@remixicon/react"

import { useNotebooks } from "@/hooks/use-notebooks"
import { useSwitchNotebook } from "@/hooks/use-switch-notebook"
import { collectSharedNotes } from "@/components/custom-ui/file-browser/tree"
import type { Notebook } from "@/components/custom-ui/file-browser/tree"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { NotebookRow, type NotebookRowData } from "@/components/custom-ui/notebook-dialogs/notebook-row"
import { ShareNotebookModal } from "@/components/custom-ui/notebook-dialogs/share-notebook-modal"
import { exportNotebookArchive } from "@/lib/notebook-export"
import { downloadBlob } from "@/lib/download-file"
import type { NoteExportFormat } from "@/lib/note-export"

import "./manage-notebooks-dialog.scss"

type ManageNotebooksDialogProps = {
  open: boolean
  onClose: () => void
  /** Opens the "create notebook" dialog as a panel stacked on top of the manager. */
  onCreateNew: () => void
  /** True while another panel (e.g. the new-notebook dialog) is stacked on top of this one. */
  isObscured?: boolean
  className?: string
}

type Tab = "manage" | "sharedNotebooks" | "sharedNotes"
type GroupBy = "none" | "notebook" | "direction" | "method"

/** A row plus the bits needed for grouping/section-building. Manage rows skip
 *  this entirely since the Manage tab is never grouped. */
type SharedRowEntry = {
  key: string
  data: NotebookRowData
  /** Owning notebook name, used by the "Notebook" grouping mode. */
  home: string | null
  inbound: boolean
  onOpen: () => void
}

type Section = {
  key: string
  label: string
  count: number
  showHeader: boolean
  rows: SharedRowEntry[]
}

function buildSections(rows: SharedRowEntry[], mode: GroupBy): Section[] {
  if (mode === "none") {
    return [{ key: "all", label: "", count: rows.length, showHeader: false, rows }]
  }

  const keyOf = (r: SharedRowEntry) => {
    if (mode === "notebook") return r.home || "Shared with me"
    if (mode === "direction") return r.inbound ? "Shared with me" : "Shared by me"
    if (mode === "method") return r.data.shareMethod === "invite" ? "By invite" : "By link"
    return "all"
  }

  const order: string[] = []
  const map: Record<string, Section> = {}
  rows.forEach((r) => {
    const k = keyOf(r)
    if (!map[k]) {
      map[k] = { key: k, label: k, count: 0, showHeader: true, rows: [] }
      order.push(k)
    }
    map[k].rows.push(r)
    map[k].count += 1
  })

  if (mode === "direction") {
    order.sort((a, b) => (a === "Shared with me" ? 0 : 1) - (b === "Shared with me" ? 0 : 1))
  }
  if (mode === "notebook") {
    order.sort((a, b) => (a === "Shared with me" ? 1 : 0) - (b === "Shared with me" ? 1 : 0))
  }

  return order.map((k) => map[k])
}

export function ManageNotebooksDialog({
  open,
  onClose,
  onCreateNew,
  isObscured,
  className,
}: ManageNotebooksDialogProps) {
  const { notebooks, currentId, setCurrent, renameNotebook, deleteNotebook, importNotebook } = useNotebooks()
  const switchNotebook = useSwitchNotebook()
  const navigate = useNavigate()

  const [tab, setTab] = React.useState<Tab>("manage")
  const [groupBy, setGroupBy] = React.useState<GroupBy>("direction")
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  const [exportingId, setExportingId] = React.useState<string | null>(null)
  const [sharingNotebook, setSharingNotebook] = React.useState<Notebook | null>(null)
  const [isImporting, setIsImporting] = React.useState(false)
  const [importError, setImportError] = React.useState<string | null>(null)
  const importInputRef = React.useRef<HTMLInputElement | null>(null)

  const createdFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    []
  )

  React.useEffect(() => {
    if (!open) {
      setRenamingId(null)
      setRenameError(null)
      setConfirmDeleteId(null)
      setImportError(null)
      setSharingNotebook(null)
    }
  }, [open])

  const handleOpenNotebook = React.useCallback(
    async (notebook: Notebook) => {
      onClose()
      await switchNotebook(notebook)
    },
    [onClose, switchNotebook]
  )

  const handleOpenNote = React.useCallback(
    (notebookId: string, noteId: string) => {
      onClose()
      if (notebookId !== currentId) setCurrent(notebookId)
      navigate(`/nb/${notebookId}/n/${noteId}`)
    },
    [onClose, currentId, setCurrent, navigate]
  )

  const startRename = React.useCallback((notebook: Notebook) => {
    setConfirmDeleteId(null)
    setRenameValue(notebook.name)
    setRenameError(null)
    setRenamingId(notebook.id)
  }, [])

  const commitRename = React.useCallback(() => {
    if (!renamingId) return
    try {
      renameNotebook(renamingId, renameValue)
      setRenamingId(null)
      setRenameError(null)
    } catch (err) {
      // Keep the row in edit mode so the user can fix the name.
      setRenameError(err instanceof Error ? err.message : "Something went wrong.")
    }
  }, [renamingId, renameValue, renameNotebook])

  const cancelRename = React.useCallback(() => {
    setRenamingId(null)
    setRenameError(null)
  }, [])

  const changeRenameValue = React.useCallback((value: string) => {
    setRenameValue(value)
    setRenameError(null)
  }, [])

  const handleDelete = React.useCallback(
    async (notebook: Notebook) => {
      const wasCurrent = notebook.id === currentId
      setConfirmDeleteId(null)
      await deleteNotebook(notebook.id)
      if (wasCurrent) {
        onClose()
        navigate("/", { replace: true })
      }
    },
    [currentId, deleteNotebook, navigate, onClose]
  )

  const handleExport = React.useCallback(async (notebook: Notebook, format: NoteExportFormat) => {
    setExportingId(notebook.id)
    try {
      const archive = await exportNotebookArchive(notebook, format)
      downloadBlob(`${notebook.name || "Notebook"} (${format}).zip`, new Blob([archive], { type: "application/zip" }))
    } catch (e) {
      console.error(`Failed to export notebook ${notebook.id}:`, e)
    } finally {
      setExportingId(null)
    }
  }, [])

  const handleImportClick = React.useCallback(() => {
    setImportError(null)
    importInputRef.current?.click()
  }, [])

  const handleImportFile = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return

      setIsImporting(true)
      setImportError(null)
      try {
        const notebook = await importNotebook(file)
        onClose()
        await switchNotebook(notebook)
      } catch (err) {
        console.error("Failed to import notebook:", err)
        setImportError(err instanceof Error ? err.message : "Failed to import notebook.")
      } finally {
        setIsImporting(false)
      }
    },
    [importNotebook, onClose, switchNotebook]
  )

  React.useEffect(() => {
    if (!open) return

    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (renamingId) {
        event.stopPropagation()
        cancelRename()
        return
      }
      if (confirmDeleteId) {
        event.stopPropagation()
        setConfirmDeleteId(null)
        return
      }
      if (sharingNotebook) {
        event.stopPropagation()
        setSharingNotebook(null)
        return
      }
      // A panel stacked on top (e.g. New notebook) owns Escape while it's open.
      if (isObscured) return
      onClose()
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onClose, renamingId, confirmDeleteId, sharingNotebook, cancelRename, isObscured])

  const sortedNotebooks = React.useMemo(
    () => [...notebooks].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [notebooks]
  )

  // Per-notebook list of notes that currently have link sharing turned on —
  // this is the only kind of sharing the app actually supports today, so it
  // doubles as the source of truth for both "shared" tabs below.
  const sharedByNotebook = React.useMemo(
    () => sortedNotebooks.map((notebook) => ({ notebook, shared: collectSharedNotes(notebook.root) })),
    [sortedNotebooks]
  )

  const sharedNotebookRows = React.useMemo<SharedRowEntry[]>(() => {
    return sharedByNotebook
      .filter(({ shared }) => shared.length > 0)
      .map(({ notebook, shared }) => {
        const hasEdit = shared.some((n) => n.linkAccess === "edit")
        const allEdit = shared.every((n) => n.linkAccess === "edit")
        const permission = allEdit ? "edit" : hasEdit ? "mixed" : "view"
        const data: NotebookRowData = {
          id: notebook.id,
          name: notebook.name,
          statusText: `${shared.length} shared note${shared.length === 1 ? "" : "s"}`,
          tone: hasEdit ? "warn" : "good",
          shareMethod: "link",
          permission,
          direction: "out",
          directionLabel: "You shared",
        }
        return {
          key: notebook.id,
          data,
          home: null,
          inbound: false,
          onOpen: () => handleOpenNotebook(notebook),
        }
      })
  }, [sharedByNotebook, handleOpenNotebook])

  const sharedNoteRows = React.useMemo<SharedRowEntry[]>(() => {
    return sharedByNotebook.flatMap(({ notebook, shared }) =>
      shared.map((note) => {
        const data: NotebookRowData = {
          id: note.id,
          name: note.name,
          statusText: `in ${notebook.name}`,
          tone: note.linkAccess === "edit" ? "warn" : "good",
          shareMethod: "link",
          permission: note.linkAccess === "edit" ? "edit" : "view",
          direction: "out",
          directionLabel: "You shared",
        }
        return {
          key: `${notebook.id}:${note.id}`,
          data,
          home: notebook.name,
          inbound: false,
          onOpen: () => handleOpenNote(notebook.id, note.id),
        }
      })
    )
  }, [sharedByNotebook, handleOpenNote])

  const isManage = tab === "manage"
  const isSharedNotebooks = tab === "sharedNotebooks"
  const isSharedNotes = tab === "sharedNotes"

  const effectiveGroupBy: GroupBy = isManage
    ? "none"
    : groupBy === "notebook" && !isSharedNotes
      ? "none"
      : groupBy

  const activeSharedRows = isSharedNotebooks ? sharedNotebookRows : isSharedNotes ? sharedNoteRows : []
  const sections = React.useMemo(
    () => buildSections(activeSharedRows, effectiveGroupBy),
    [activeSharedRows, effectiveGroupBy]
  )

  const pluralize = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

  const contextLine = isManage
    ? `${pluralize(sortedNotebooks.length, "notebook")} · on this device`
    : isSharedNotebooks
      ? `${pluralize(sharedNotebookRows.length, "notebook")} with shared notes`
      : `${pluralize(sharedNoteRows.length, "note")} shared via link`

  const title = isManage ? "My notebooks" : isSharedNotebooks ? "Shared notebooks" : "Shared notes"

  const emptyMessage = isManage
    ? "No notebooks found."
    : isSharedNotebooks
      ? "No notebooks have shared notes yet. Turn on link sharing from inside a note to see it here."
      : "No notes are shared yet. Turn on link sharing from inside a note to see it here."

  if (!open) return null

  return (
    <div
      className="manage-notebooks-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={["manage-notebooks-dialog", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label="Notebooks"
      >
        <div className="nb-rail">
          <div className="nb-rail-brand">
            <RiBookShelfLine className="nb-rail-brand-icon" />
            <h2>Notebooks</h2>
          </div>

          <div className="nb-rail-label">Views</div>
          <nav className="nb-rail-nav">
            <button
              type="button"
              className={["nb-rail-item", isManage ? "is-active" : ""].join(" ")}
              onClick={() => setTab("manage")}
            >
              <span className="nb-rail-item-dot" aria-hidden />
              <span className="nb-rail-item-label">My notebooks</span>
              <span className="nb-rail-item-count">{sortedNotebooks.length}</span>
            </button>
            <button
              type="button"
              className={["nb-rail-item", isSharedNotebooks ? "is-active" : ""].join(" ")}
              onClick={() => setTab("sharedNotebooks")}
            >
              <span className="nb-rail-item-dot" aria-hidden />
              <span className="nb-rail-item-label">Shared notebooks</span>
              <span className="nb-rail-item-count">{sharedNotebookRows.length}</span>
            </button>
            <button
              type="button"
              className={["nb-rail-item", isSharedNotes ? "is-active" : ""].join(" ")}
              onClick={() => setTab("sharedNotes")}
            >
              <span className="nb-rail-item-dot" aria-hidden />
              <span className="nb-rail-item-label">Shared notes</span>
              <span className="nb-rail-item-count">{sharedNoteRows.length}</span>
            </button>
          </nav>

          <div className="nb-rail-footer">
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleImportFile}
              hidden
            />
            <Button
              type="button"
              data-style="ghost"
              className="nb-rail-import-btn"
              disabled={isImporting}
              onClick={handleImportClick}
            >
              <RiUploadLine className="tiptap-button-icon" />
              <span className="tiptap-button-text">{isImporting ? "Importing…" : "Import notebook"}</span>
            </Button>
            {importError && <div className="nb-rail-import-error">{importError}</div>}
            <div className="nb-rail-status">
              <span className="nb-rail-status-dot" aria-hidden /> Changes saved locally
            </div>
          </div>
        </div>

        <div className="nb-content">
          <div className="nb-content-header">
            <div className="nb-content-heading">
              <h3>{title}</h3>
              <div className="nb-content-subtitle">{contextLine}</div>
            </div>
            <div className="nb-content-actions">
              {isManage && (
                <Button
                  type="button"
                  className="nb-new-btn"
                  onClick={onCreateNew}
                >
                  <RiAddLine className="tiptap-button-icon" />
                  <span className="tiptap-button-text">New notebook</span>
                </Button>
              )}
              {!isManage && (
                <Button
                  type="button"
                  data-style="ghost"
                  disabled
                  tooltip="Invites aren't available yet"
                  aria-label="Invite people (coming soon)"
                >
                  <span className="tiptap-button-text">Invite people</span>
                </Button>
              )}
              <Button
                type="button"
                data-style="ghost"
                aria-label="Close"
                tooltip="Close"
                onClick={onClose}
              >
                <RiCloseLine className="tiptap-button-icon" />
              </Button>
            </div>
          </div>

          {!isManage && (
            <div className="nb-groupby">
              <span className="nb-groupby-label">Group by</span>
              <div className="nb-groupby-pills">
                <button
                  type="button"
                  className={["nb-pill", effectiveGroupBy === "none" ? "is-active" : ""].join(" ")}
                  onClick={() => setGroupBy("none")}
                >
                  Flat
                </button>
                {isSharedNotes && (
                  <button
                    type="button"
                    className={["nb-pill", effectiveGroupBy === "notebook" ? "is-active" : ""].join(" ")}
                    onClick={() => setGroupBy("notebook")}
                  >
                    Notebook
                  </button>
                )}
                <button
                  type="button"
                  className={["nb-pill", effectiveGroupBy === "direction" ? "is-active" : ""].join(" ")}
                  onClick={() => setGroupBy("direction")}
                >
                  Direction
                </button>
                <button
                  type="button"
                  className={["nb-pill", effectiveGroupBy === "method" ? "is-active" : ""].join(" ")}
                  onClick={() => setGroupBy("method")}
                >
                  Method
                </button>
              </div>
            </div>
          )}

          <div className="nb-list" role="listbox" aria-label={title}>
            {isManage ? (
              sortedNotebooks.length === 0 ? (
                <div className="nb-empty">{emptyMessage}</div>
              ) : (
                <ul>
                  {sortedNotebooks.map((notebook) => {
                    const isActive = notebook.id === currentId
                    const sharedCount = sharedByNotebook.find((s) => s.notebook.id === notebook.id)?.shared.length ?? 0
                    const data: NotebookRowData = {
                      id: notebook.id,
                      name: notebook.name,
                      statusText: isActive
                        ? "Currently open"
                        : `Created ${createdFormatter.format(new Date(notebook.createdAt))}`,
                      tone: isActive ? "accent" : sharedCount > 0 ? "good" : "neutral",
                    }
                    return (
                      <NotebookRow
                        key={notebook.id}
                        row={data}
                        onOpen={() => handleOpenNotebook(notebook)}
                        manageActions={{
                          isRenaming: renamingId === notebook.id,
                          renameValue,
                          renameError: renamingId === notebook.id ? renameError : null,
                          onRenameChange: changeRenameValue,
                          onCommitRename: commitRename,
                          onCancelRename: cancelRename,
                          onStartRename: () => startRename(notebook),
                          isConfirmingDelete: confirmDeleteId === notebook.id,
                          onRequestDelete: () => setConfirmDeleteId(notebook.id),
                          onCancelDelete: () => setConfirmDeleteId(null),
                          onConfirmDelete: () => handleDelete(notebook),
                          onExport: (format) => handleExport(notebook, format),
                          isExporting: exportingId === notebook.id,
                          onShare: () => setSharingNotebook(notebook),
                        }}
                      />
                    )
                  })}
                </ul>
              )
            ) : activeSharedRows.length === 0 ? (
              <div className="nb-empty">{emptyMessage}</div>
            ) : (
              sections.map((sec) => (
                <ul key={sec.key} className="nb-section">
                  {sec.showHeader && (
                    <li className="nb-section-header">
                      <span className="nb-section-label">{sec.label}</span>
                      <span className="nb-section-line" aria-hidden />
                      <span className="nb-section-count">{sec.count}</span>
                    </li>
                  )}
                  {sec.rows.map((row) => (
                    <NotebookRow key={row.key} row={row.data} onOpen={row.onOpen} />
                  ))}
                </ul>
              ))
            )}
          </div>
        </div>
      </div>

      {sharingNotebook && (
        <ShareNotebookModal
          notebookId={sharingNotebook.id}
          notebookName={sharingNotebook.name}
          open
          onClose={() => setSharingNotebook(null)}
        />
      )}
    </div>
  )
}

export default ManageNotebooksDialog
