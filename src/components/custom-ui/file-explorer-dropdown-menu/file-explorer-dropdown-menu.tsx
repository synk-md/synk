"use client"

import * as React from "react"

// --- Icons ---
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"
import { RiBookShelfLine, RiGlobalLine, RiQuestionMark } from "@remixicon/react"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/tiptap-ui-primitive/dropdown-menu"

// --- Hook ---
import { useFileExplorerDropdownMenu } from "@/components/custom-ui/file-explorer-dropdown-menu"
import { NewNotebookDialog } from "@/components/custom-ui/notebook-dialogs/new-notebook-dialog"
import { ManageNotebooksDialog } from "@/components/custom-ui/notebook-dialogs/manage-notebooks-dialog"
import { NotebookSwitchMenu } from "@/components/custom-ui/file-explorer-dropdown-menu/notebook-switch-menu"
import { useNotebooks } from "@/hooks/use-notebooks"

export interface FileExplorerDropdownMenuProps extends Omit<ButtonProps, "type"> {
  portal?: boolean
  onOpenChange?: (isOpen: boolean) => void
  onNotebookCreated?: (notebookId: string, noteId: string) => void
  showNotebookLockIndicator?: boolean
  isShared?: boolean
}

export const FileExplorerDropdownMenu = React.forwardRef<
  HTMLButtonElement,
  FileExplorerDropdownMenuProps
>(({ portal = false, onOpenChange, onNotebookCreated, showNotebookLockIndicator = false, isShared = false, ...buttonProps }, ref) => {
  
  const { isOpen, setIsOpen, handleOpenChange, handlers, dialogs } =
    useFileExplorerDropdownMenu({ onNotebookCreated })

  const { currentNotebook } = useNotebooks()

  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  // merge forwarded ref with triggerRef
  React.useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement)

  const handleChange = React.useCallback(
    (open: boolean) => {
      handleOpenChange(open)
      onOpenChange?.(open)
    },
    [handleOpenChange, onOpenChange]
  )

  return (
    <>
      <DropdownMenu modal open={isOpen} onOpenChange={handleChange}>
        <DropdownMenuTrigger asChild>
          {showNotebookLockIndicator ? (
          <Button type="button" data-style="ghost">
            <RiBookShelfLine className="tiptap-button-icon" />
            <span className="tiptap-button-text">
              <RiQuestionMark className="tiptap-button-icon"/>
            </span>
            <ChevronDownIcon className="tiptap-button-dropdown-small ml-1" />
          </Button>
          ) : (
          <Button
            type="button"
            data-style="ghost"
            data-active-state={isOpen ? "on" : "off"}
            role="button"
            tabIndex={-1}
            aria-label="Notebook options"
            aria-pressed={isOpen}
            tooltip="Change notebook"
            {...buttonProps}
            ref={triggerRef}
          >
            <RiBookShelfLine className="tiptap-button-icon" />
            <span className="tiptap-button-text">
              {currentNotebook?.name || "Notebooks"}
            </span>
            {isShared && (
              <RiGlobalLine
                className="tiptap-button-icon"
                style={{ color: "var(--tt-brand-color-300)" }}
                aria-label="Notebook is shared"
              />
            )}
            <ChevronDownIcon className="tiptap-button-dropdown-small ml-1" />
          </Button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" portal={portal}>
          <NotebookSwitchMenu
            onManageNotebooks={handlers.onManageNotebooks}
            onClose={() => setIsOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <ManageNotebooksDialog
        open={dialogs.manageNotebooks.open}
        onClose={dialogs.manageNotebooks.closeDialog}
        onCreateNew={handlers.onNotebookCreated}
        isObscured={dialogs.newNotebook.open}
      />

      <NewNotebookDialog
        open={dialogs.newNotebook.open}
        onClose={dialogs.newNotebook.closeDialog}
        onCreated={(nbId, noteId) => {
          dialogs.newNotebook.closeDialog()
          dialogs.manageNotebooks.closeDialog()
          dialogs.newNotebook.onNotebookCreated?.(nbId, noteId)
        }}
      />
    </>
  )
})

FileExplorerDropdownMenu.displayName = "FileExplorerDropdownMenu"

export default FileExplorerDropdownMenu
