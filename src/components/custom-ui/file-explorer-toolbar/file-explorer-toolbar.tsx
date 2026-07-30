import * as React from "react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/tiptap-ui-primitive/dropdown-menu"
import { ToolbarGroup } from "@/components/tiptap-ui-primitive/toolbar"
import type { FileTreeSortOrder } from "@/components/custom-ui/file-browser/tree"
import { isImportableNoteFile, type NoteImportItem } from "@/lib/note-import"
import {
  RiCheckLine,
  RiCollapseVerticalLine,
  RiFileAddLine,
  RiFolderAddLine,
  RiFolderUploadLine,
  RiSortAsc,
  RiStickyNoteAddLine,
  RiUploadLine,
} from "@remixicon/react"

import "./file-explorer-toolbar.scss"

const sortOptions: Array<{ value: FileTreeSortOrder; label: string }> = [
  { value: "name-asc", label: "File name (A to Z)" },
  { value: "name-desc", label: "File name (Z to A)" },
  { value: "modified-desc", label: "Modified time (new to old)" },
  { value: "modified-asc", label: "Modified time (old to new)" },
  { value: "created-desc", label: "Created time (new to old)" },
  { value: "created-asc", label: "Created time (old to new)" },
]

export type FileExplorerToolbarProps = {
  onCreateNote: () => void
  onCreateFolder: () => void
  onImportFiles: (files: NoteImportItem[]) => void
  onCollapseAll: () => void
  sortOrder: FileTreeSortOrder
  onSortOrderChange: (sortOrder: FileTreeSortOrder) => void
  className?: string
  disabled?: boolean
}

export function FileExplorerToolbar({
  onCreateNote,
  onCreateFolder,
  onImportFiles,
  onCollapseAll,
  sortOrder,
  onSortOrderChange,
  disabled = false,
}: FileExplorerToolbarProps) {
  const activeSortLabel = sortOptions.find((option) => option.value === sortOrder)?.label ?? "Sort order"
  const importInputRef = React.useRef<HTMLInputElement | null>(null)
  const folderInputRef = React.useRef<HTMLInputElement | null>(null)

  return (
    <div className="fe-toolbar">
      <ToolbarGroup>
        <Button
          type="button"
          data-style="ghost"
          tooltip="New note"
          onClick={onCreateNote}
          aria-label="Create a new note"
          disabled={disabled}
        >
          <RiStickyNoteAddLine className="tiptap-button-icon" />
        </Button>

        <Button
          type="button"
          data-style="ghost"
          tooltip="New folder"
          onClick={onCreateFolder}
          aria-label="Create a new folder"
          disabled={disabled}
        >
          <RiFolderAddLine className="tiptap-button-icon" />
        </Button>

        <input
          ref={importInputRef}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.json,text/markdown,text/plain,application/json"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
              .filter(isImportableNoteFile)
              .map((file) => ({ file }))
            e.target.value = ""
            if (files.length) onImportFiles(files)
          }}
        />

        <input
          ref={folderInputRef}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.json,text/markdown,text/plain,application/json"
          hidden
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
              .filter(isImportableNoteFile)
              .map((file) => ({
                file,
                path: file.webkitRelativePath || file.name,
              }))
            e.target.value = ""
            if (files.length) onImportFiles(files)
          }}
        />

        <DropdownMenu>
          <DropdownMenuTrigger
            className="tiptap-button"
            data-style="ghost"
            aria-label={`Sort: ${activeSortLabel}`}
            disabled={disabled}
          >
            <RiSortAsc className="tiptap-button-icon" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="fe-sort-menu" align="center" sideOffset={6} portal>
            {sortOptions.map((option) => (
              <DropdownMenuItem
                key={option.value}
                className="fe-sort-menu-item"
                onSelect={() => onSortOrderChange(option.value)}
              >
                <span className="fe-sort-menu-check">
                  {option.value === sortOrder && <RiCheckLine className="tiptap-button-icon" />}
                </span>
                <span>{option.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          data-style="ghost"
          tooltip="Collapse all"
          onClick={onCollapseAll}
          aria-label="Collapse all folders"
          disabled={disabled}
        >
          <RiCollapseVerticalLine className="tiptap-button-icon" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="tiptap-button"
            data-style="ghost"
            aria-label="Import notes"
            disabled={disabled}
          >
            <RiUploadLine className="tiptap-button-icon" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="fe-sort-menu" align="center" sideOffset={6} portal>
            <DropdownMenuItem
              className="fe-sort-menu-item fe-import-menu-item"
              onSelect={() => importInputRef.current?.click()}
            >
              <RiFileAddLine className="tiptap-button-icon" />
              <span>Import files</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="fe-sort-menu-item fe-import-menu-item"
              onSelect={() => folderInputRef.current?.click()}
            >
              <RiFolderUploadLine className="tiptap-button-icon" />
              <span>Import folder</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ToolbarGroup>
    </div>
  )
}
