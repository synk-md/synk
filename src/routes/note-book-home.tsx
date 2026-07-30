import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useNotebooks } from "@/hooks/use-notebooks"

export function NotebookHome() {
  const { notebookId } = useParams<{ notebookId: string }>()
  const { notebooks } = useNotebooks()
  const navigate = useNavigate()

  const notebook = notebooks.find(n => n.id === notebookId)
  React.useEffect(() => {
    if (!notebookId || !notebook) {
      navigate("/404", { replace: true })
      return
    }

    let cancelled = false

    ;(async () => {
      //const target = await resolveNotebookTargetNote(notebookId, notebook.root)

      if (cancelled) return

      if (notebookId) navigate(`/nb/${notebookId}`, { replace: true })
      else navigate("/404", { replace: true })
    })()

    return () => {
      cancelled = true
    }
  }, [notebookId, notebook, navigate])

  return null // we immediately redirect
}
