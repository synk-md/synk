"use client"

import * as React from "react"
import {
  RiArrowRightLine,
  RiBracesLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiFileTextLine,
  RiLinkM,
  RiLoader4Line,
  RiMailLine,
  RiMarkdownLine,
  RiPencilLine,
  RiShareLine,
} from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { MenuSurface, type MenuItem } from "@/components/custom-ui/context-menu"
import type { NoteExportFormat } from "@/lib/note-export"

import "./notebook-row.scss"

// Same three formats/icons as the file explorer's per-note "Download" panel,
// rendered through the same MenuSurface so the two look and behave alike.
function buildExportMenuItems(onExport: (format: NoteExportFormat) => void): MenuItem<null>[] {
  return [
    {
      id: "export-markdown",
      label: "Markdown (.md)",
      icon: <RiMarkdownLine className="tiptap-button-icon" />,
      run: () => onExport("markdown"),
    },
    {
      id: "export-json",
      label: "JSON (.json)",
      icon: <RiBracesLine className="tiptap-button-icon" />,
      run: () => onExport("json"),
    },
    {
      id: "export-text",
      label: "Plain Text (.txt)",
      icon: <RiFileTextLine className="tiptap-button-icon" />,
      run: () => onExport("text"),
    },
  ]
}

export type RowTone = "accent" | "good" | "warn" | "neutral"
export type ShareMethod = "invite" | "link"
export type SharePermission = "edit" | "view" | "mixed"

export type NotebookRowData = {
  id: string
  name: string
  /** Sub-label shown under the name, e.g. "Currently open", "in Birds", "3 shared notes". */
  statusText: string
  tone: RowTone
  /** Shown only for shared rows; omitted on the Manage tab. */
  shareMethod?: ShareMethod
  permission?: SharePermission
  /** Always "out" today — there is no inbound/received sharing yet. */
  direction?: "in" | "out"
  directionLabel?: string
}

type NotebookRowProps = {
  row: NotebookRowData
  onOpen: () => void
  /** Manage-tab-only rename/delete affordances; omitted for shared rows since
   *  there's no real "unshare" or "rename" primitive wired up for those yet. */
  manageActions?: {
    isRenaming: boolean
    renameValue: string
    renameError?: string | null
    onRenameChange: (value: string) => void
    onCommitRename: () => void
    onCancelRename: () => void
    onStartRename: () => void
    isConfirmingDelete: boolean
    onRequestDelete: () => void
    onCancelDelete: () => void
    onConfirmDelete: () => void
    onExport: (format: NoteExportFormat) => void
    isExporting: boolean
    onShare: () => void
  }
}

const permissionLabel: Record<SharePermission, string> = {
  edit: "Can edit",
  view: "Can view",
  mixed: "Mixed access",
}

export function NotebookRow({ row, onOpen, manageActions }: NotebookRowProps) {
  const isRenaming = manageActions?.isRenaming ?? false
  const isConfirmingDelete = manageActions?.isConfirmingDelete ?? false

  const exportTriggerRef = React.useRef<HTMLButtonElement>(null)
  const exportMenuRef = React.useRef<HTMLDivElement>(null)
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  const [exportMenuPos, setExportMenuPos] = React.useState<{ x: number; y: number } | null>(null)

  const renameError = manageActions?.renameError
  React.useEffect(() => {
    // A failed rename (e.g. duplicate name) blurs the input on the way to
    // showing the error — pull focus back so the user can fix it in place.
    if (renameError) renameInputRef.current?.focus()
  }, [renameError])

  const closeExportMenu = React.useCallback(() => setExportMenuPos(null), [])

  React.useEffect(() => {
    if (!exportMenuPos) return

    const handleMouseDown = (event: MouseEvent) => {
      if (exportMenuRef.current && exportMenuRef.current.contains(event.target as Node)) return
      if (exportTriggerRef.current && exportTriggerRef.current.contains(event.target as Node)) return
      closeExportMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExportMenu()
    }
    const handleScroll = () => closeExportMenu()

    document.addEventListener("mousedown", handleMouseDown)
    // Capture phase: the trigger button still has focus when this menu opens,
    // and its tooltip (via floating-ui's useFocus/useDismiss) stops Escape
    // from reaching a bubble-phase document listener by default.
    document.addEventListener("keydown", handleKeyDown, true)
    document.addEventListener("scroll", handleScroll, true)
    return () => {
      document.removeEventListener("mousedown", handleMouseDown)
      document.removeEventListener("keydown", handleKeyDown, true)
      document.removeEventListener("scroll", handleScroll, true)
    }
  }, [exportMenuPos, closeExportMenu])

  const exportMenuItems = React.useMemo(
    () => (manageActions ? buildExportMenuItems(manageActions.onExport) : []),
    [manageActions],
  )

  return (
    <li
      className="nb-row"
      data-tone={row.tone}
      onMouseLeave={() => {
        if (isConfirmingDelete) manageActions?.onCancelDelete()
      }}
    >
      {isRenaming && manageActions ? (
        <>
          <input
            ref={renameInputRef}
            autoFocus
            className={["nb-row-rename-input", manageActions.renameError ? "is-error" : ""].join(" ")}
            value={manageActions.renameValue}
            maxLength={80}
            onChange={(e) => manageActions.onRenameChange(e.target.value)}
            onBlur={manageActions.onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                manageActions.onCommitRename()
              } else if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                manageActions.onCancelRename()
              }
            }}
          />
          {manageActions.renameError && (
            <span className="nb-row-rename-error">{manageActions.renameError}</span>
          )}
        </>
      ) : (
        <button type="button" className="nb-row-main" onClick={onOpen}>
          <span className="nb-row-tile">{row.name.charAt(0).toUpperCase() || "?"}</span>
          <span className="nb-row-text">
            <span className="nb-row-name">{row.name}</span>
            <span className="nb-row-meta">
              <span className="nb-row-dot" aria-hidden />
              {row.shareMethod && (
                <span className={`nb-row-badge nb-row-badge--${row.shareMethod}`}>
                  {row.shareMethod === "invite" ? (
                    <RiMailLine className="nb-row-badge-icon" />
                  ) : (
                    <RiLinkM className="nb-row-badge-icon" />
                  )}
                  {row.shareMethod === "invite" ? "Invite" : "Link"}
                </span>
              )}
              {row.directionLabel && <span className="nb-row-direction">{row.directionLabel}</span>}
              <span className="nb-row-status">{row.statusText}</span>
            </span>
          </span>
        </button>
      )}

      <div className={`nb-row-actions${exportMenuPos ? " nb-row-actions--menu-open" : ""}`}>
        {row.permission && <span className="nb-row-perm">{permissionLabel[row.permission]}</span>}

        {manageActions ? (
          isConfirmingDelete ? (
            <>
              <span className="nb-row-confirm-label">Delete?</span>
              <Button
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn nb-row-icon-btn--danger"
                aria-label={`Confirm delete ${row.name}`}
                tooltip="Delete forever"
                onClick={manageActions.onConfirmDelete}
              >
                <RiCheckLine className="tiptap-button-icon" />
              </Button>
              <Button
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn"
                aria-label="Cancel delete"
                tooltip="Cancel"
                onClick={manageActions.onCancelDelete}
              >
                <RiCloseLine className="tiptap-button-icon" />
              </Button>
            </>
          ) : !isRenaming ? (
            <>
              <Button
                ref={exportTriggerRef}
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn"
                aria-label={`Export ${row.name}`}
                tooltip={manageActions.isExporting ? "Exporting…" : "Export notebook"}
                disabled={manageActions.isExporting}
                onClick={() => {
                  const rect = exportTriggerRef.current?.getBoundingClientRect()
                  if (rect) setExportMenuPos({ x: rect.right, y: rect.bottom })
                }}
              >
                {manageActions.isExporting ? (
                  <RiLoader4Line className="tiptap-button-icon nb-row-icon-spin" />
                ) : (
                  <RiDownloadLine className="tiptap-button-icon" />
                )}
              </Button>
              <Button
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn"
                aria-label={`Share ${row.name}`}
                tooltip="Share notebook"
                onClick={manageActions.onShare}
              >
                <RiShareLine className="tiptap-button-icon" />
              </Button>
              <Button
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn"
                aria-label={`Rename ${row.name}`}
                tooltip="Rename"
                onClick={manageActions.onStartRename}
              >
                <RiPencilLine className="tiptap-button-icon" />
              </Button>
              <Button
                type="button"
                data-style="ghost"
                className="nb-row-icon-btn"
                aria-label={`Delete ${row.name}`}
                tooltip="Delete"
                onClick={manageActions.onRequestDelete}
              >
                <RiDeleteBinLine className="tiptap-button-icon" />
              </Button>
            </>
          ) : null
        ) : (
          <Button
            type="button"
            data-style="ghost"
            className="nb-row-icon-btn"
            aria-label={`Open ${row.name}`}
            tooltip="Open"
            onClick={onOpen}
          >
            <RiArrowRightLine className="tiptap-button-icon" />
          </Button>
        )}
      </div>

      {exportMenuPos && manageActions && (
        <div
          ref={exportMenuRef}
          style={{
            position: "fixed",
            top: exportMenuPos.y,
            left: exportMenuPos.x,
            transform: "translate(-100%, 6px)",
            zIndex: 9999,
          }}
        >
          <MenuSurface
            spec={exportMenuItems}
            ctx={null}
            onClose={closeExportMenu}
            cardStyle={{ minWidth: 200 }}
          />
        </div>
      )}
    </li>
  )
}

export default NotebookRow
