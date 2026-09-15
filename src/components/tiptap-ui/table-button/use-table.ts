"use client"

import * as React from "react"
import { type Editor } from "@tiptap/react"
import { RiTable2 } from "@remixicon/react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Lib ---
import { isNodeInSchema } from "@/lib/tiptap-utils"

export interface UseTableConfig {
  /**
   * The Tiptap editor instance.
   */
  editor?: Editor | null
  /**
   * Called after a table was inserted.
   */
  onInserted?: () => void
}

/**
 * Tables can't be nested, so inserting is only allowed outside of one.
 */
export function canInsertTable(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  if (!isNodeInSchema("table", editor)) return false
  if (editor.isActive("table")) return false
  return editor.can().insertTable()
}

export function insertTable(editor: Editor | null): boolean {
  if (!canInsertTable(editor)) return false
  return editor!
    .chain()
    .focus()
    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    .run()
}

export function useTable(config?: UseTableConfig) {
  const { editor: providedEditor, onInserted } = config || {}
  const { editor } = useTiptapEditor(providedEditor)
  const [canInsert, setCanInsert] = React.useState<boolean>(() => canInsertTable(editor))

  React.useEffect(() => {
    if (!editor) return

    const update = () => setCanInsert(canInsertTable(editor))
    update()

    editor.on("selectionUpdate", update)
    editor.on("update", update)
    return () => {
      editor.off("selectionUpdate", update)
      editor.off("update", update)
    }
  }, [editor])

  const handleInsert = React.useCallback(() => {
    const success = insertTable(editor)
    if (success) onInserted?.()
    return success
  }, [editor, onInserted])

  return {
    isVisible: !!editor && editor.isEditable && isNodeInSchema("table", editor),
    canInsert,
    handleInsert,
    label: "Insert table",
    Icon: RiTable2,
  }
}
