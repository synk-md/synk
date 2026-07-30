"use client"

import * as React from "react"
import { RiSearchLine } from "@remixicon/react"

import { collectNoteEntries } from "@/components/custom-ui/file-browser/tree"
import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import { QuickPick } from "@/components/custom-ui/quick-pick/quick-pick"

type NoteQuickSwitcherProps = {
  open: boolean
  tree: TreeNode
  onSelect: (noteId: string) => void
  onClose: () => void
}

export function NoteQuickSwitcher({ open, tree, onSelect, onClose }: NoteQuickSwitcherProps) {
  const entries = React.useMemo(() => collectNoteEntries(tree), [tree])

  return (
    <QuickPick
      open={open}
      entries={entries}
      onSelect={onSelect}
      onClose={onClose}
      placeholder="Find a note by name…"
      ariaLabel="Find note"
      emptyMessage="No notes found."
      icon={<RiSearchLine />}
    />
  )
}
