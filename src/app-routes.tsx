// app-routes.tsx
import { Routes, Route, Outlet } from "react-router-dom"
import { SingleScreen } from "@/App"
import { NoteEditorPage } from "@/routes/note-editor-page"
import { NotFound } from "@/routes/not-found"
import { SharedNotePage } from "@/routes/shared-note-page"
import { SharedNotebookPage } from "@/routes/shared-notebook-page"
import { NotebooksProvider } from "@/hooks/use-notebooks"

function WorkspaceLayout() {
  return (
    <NotebooksProvider>
      <Outlet />
    </NotebooksProvider>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<WorkspaceLayout />}>
        <Route path="/" element={<SingleScreen />} />
        <Route path="/nb/:notebookId" element={<NoteEditorPage />} />
        <Route path="/nb/:notebookId/n/:noteId" element={<NoteEditorPage/>} />
        <Route path="/s/:notebookId" element={<SharedNotebookPage />} />
      </Route>

      <Route path="/s/:notebookId/:noteId" element={<SharedNotePage />} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
