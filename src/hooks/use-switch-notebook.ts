"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import { useNotebooks } from "@/hooks/use-notebooks"
import type { Notebook } from "@/components/custom-ui/file-browser/tree"
import { findFirstNoteId, resolveNotebookTargetNote } from "@/lib/resolve-notebook-target"

/** Switches to a notebook and navigates to its last-opened (or first) note. */
export function useSwitchNotebook() {
  const { setCurrent } = useNotebooks()
  const navigate = useNavigate()

  return React.useCallback(
    async (notebook: Notebook) => {
      setCurrent(notebook.id)

      let targetNoteId = await resolveNotebookTargetNote(notebook.id, notebook.root)
      if (!targetNoteId) targetNoteId = findFirstNoteId(notebook.root)

      if (targetNoteId) {
        navigate(`/nb/${notebook.id}/n/${targetNoteId}`)
      } else {
        navigate(`/nb/${notebook.id}`)
      }
    },
    [navigate, setCurrent]
  )
}
