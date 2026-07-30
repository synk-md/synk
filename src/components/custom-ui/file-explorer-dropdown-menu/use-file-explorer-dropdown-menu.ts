"use client"

import * as React from "react"

export interface UseFileExplorerDropdownMenuConfig {
  onNotebookCreated?: (notebookId: string, noteId: string) => void
  onManageNotebooks?: () => void
}

/**
 * Hook to encapsulate File Explorer dropdown menu actions.
 * Provides stable handlers and state management.
 */
export function useFileExplorerDropdownMenu(
  config?: UseFileExplorerDropdownMenuConfig
) {
  const [isOpen, setIsOpen] = React.useState(false)
  const [showNewNotebookDialog, setShowNewNotebookDialog] = React.useState(false)
  const [showManageNotebooksDialog, setShowManageNotebooksDialog] = React.useState(false)

  const { onNotebookCreated, onManageNotebooks } = config || {}

  const handleOpenChange = React.useCallback((open: boolean) => {
    setIsOpen(open)
  }, [])

  const openNewNotebookDialog = React.useCallback(() => {
    setIsOpen(false) // close dropdown first
    setShowNewNotebookDialog(true)
  }, [])

  const openManageNotebooksDialog = React.useCallback(() => {
    setIsOpen(false)
    setShowManageNotebooksDialog(true)
    onManageNotebooks?.()
  }, [onManageNotebooks])

  return {
    isOpen,
    setIsOpen,
    handleOpenChange,
    dialogs: {
      newNotebook: {
        open: showNewNotebookDialog,
        openDialog: () => setShowNewNotebookDialog(true),
        closeDialog: () => setShowNewNotebookDialog(false),
        onNotebookCreated,
      },
      manageNotebooks: {
        open: showManageNotebooksDialog,
        openDialog: () => setShowManageNotebooksDialog(true),
        closeDialog: () => setShowManageNotebooksDialog(false),
      },
    },
    handlers: {
      onNotebookCreated: openNewNotebookDialog,
      onManageNotebooks: openManageNotebooksDialog,
    },
  }
}
