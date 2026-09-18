import * as React from "react"
import type { Editor } from "@tiptap/react"
import { useCurrentEditor, useEditorState } from "@tiptap/react"

/**
 * Hook that provides access to a Tiptap editor instance.
 *
 * Accepts an optional editor instance directly, or falls back to retrieving
 * the editor from the Tiptap context if available. This allows components
 * to work both when given an editor directly and when used within a Tiptap
 * editor context.
 *
 * @param providedEditor - Optional editor instance to use instead of the context editor
 * @returns The provided editor or the editor from context, whichever is available
 */
export function useTiptapEditor(providedEditor?: Editor | null): {
  editor: Editor | null
  editorState?: Editor["state"]
  canCommand?: Editor["can"]
} {
  const { editor: coreEditor } = useCurrentEditor()
  const mainEditor = React.useMemo(
    () => providedEditor || coreEditor,
    [providedEditor, coreEditor]
  )

  // Subscribed only to re-render on transactions. The snapshot itself can't
  // be trusted for the instance: when the editor is recreated (e.g. once a
  // note's content has synced), useEditorState keeps serving the old,
  // destroyed editor until the new one dispatches a transaction - leaving
  // toolbar buttons bound to a dead editor until the user focuses it.
  useEditorState({
    editor: mainEditor,
    selector(context) {
      return context.editor?.state
    },
  })

  // editor.setEditable() doesn't dispatch a transaction, so the subscription
  // above never sees it. Components that read editor.isEditable while
  // rendering would otherwise keep showing the old editable state.
  const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    if (!mainEditor) return

    let wasEditable = mainEditor.isEditable
    const handleUpdate = () => {
      if (mainEditor.isEditable === wasEditable) return
      wasEditable = mainEditor.isEditable
      forceRender()
    }

    mainEditor.on("update", handleUpdate)
    return () => {
      mainEditor.off("update", handleUpdate)
    }
  }, [mainEditor])

  if (!mainEditor) return { editor: null }

  return {
    editor: mainEditor,
    editorState: mainEditor.state,
    canCommand: mainEditor.can,
  }
}
