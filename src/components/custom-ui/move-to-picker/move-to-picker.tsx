"use client"

import * as React from "react"
import { RiFolderTransferLine } from "@remixicon/react"

import { collectFolderEntries } from "@/components/custom-ui/file-browser/tree"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import { QuickPick } from "@/components/custom-ui/quick-pick/quick-pick"

type MoveToPickerProps = {
  open: boolean
  tree: TreeNode
  onSelect: (folderId: string) => void
  onClose: () => void
}

// Folder-only variant of the note quick-switcher: lets the user search for
// a destination (the notebook root or any folder) for a "Move to" action.
export function MoveToPicker({ open, tree, onSelect, onClose }: MoveToPickerProps) {
  const entries = React.useMemo(() => collectFolderEntries(tree), [tree])

  return (
    <QuickPick
      open={open}
      entries={entries}
      onSelect={onSelect}
      onClose={onClose}
      placeholder="Find a folder by name…"
      ariaLabel="Move to folder"
      emptyMessage="No folders found."
      icon={<RiFolderTransferLine />}
    />
  )
}
