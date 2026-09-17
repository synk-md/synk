import * as React from "react"
import { NotebooksProvider, useNotebooks } from "@/hooks/use-notebooks"
import { getLastOpenedNoteId } from "@/lib/notebook-settings"
import { isNoteNode } from "@/components/custom-ui/file-browser/tree"
import { NoteEditorPage } from "@/routes/note-editor-page" // your SimpleEditor wrapper
import { getOrCreateGuestIdentity, setGuestName } from "@/lib/guest-identity"
import { useNavigate } from "react-router-dom"

import "./App.scss"

function FirstRun({
  onWillCreate,
  onDismiss,
}: {
  onWillCreate?: () => void
  onDismiss?: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [name, setName] = React.useState("")
  const [yourName, setYourName] = React.useState("")
  const identityPlaceholder = React.useRef(getOrCreateGuestIdentity().name)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  // The most recently created notebook this session. Kept around after
  // "Create another" (which only flips `view` back to the form) so there's
  // a way back to it instead of a dead end.
  const [created, setCreated] = React.useState<{ notebookId: string; noteId: string; name: string } | null>(null)
  const [view, setView] = React.useState<"form" | "success">("form")
  const { createNotebook } = useNotebooks()
  const navigate = useNavigate()
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (view === "form") inputRef.current?.focus()
  }, [view])

  const onCreate = async () => {
    if (busy) return
    if (!name.trim()) {
      setErrorMessage("Please enter a name to continue")
      return
    }

    setErrorMessage(null)
    setBusy(true)
    // Tell the parent to hold off on its own redirect-to-editor effect
    // before createNotebook flips currentNotebook, so the success state
    // below actually gets a chance to render.
    onWillCreate?.()
    if (yourName.trim()) setGuestName(yourName.trim())

    try {
      const { notebookId, welcomeNoteId } = await createNotebook(name.trim())
      setCreated({ notebookId, noteId: welcomeNoteId, name: name.trim() })
      setView("success")
    } catch (err) {
      // Stay on the form (don't call onDismiss): if there's already a
      // current notebook from an earlier "Create another," dismissing here
      // would let the parent's redirect effect bounce us into it instead of
      // showing this error.
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const openNotebook = () => {
    if (!created) return
    onDismiss?.()
    navigate(`/nb/${created.notebookId}/n/${created.noteId}`, { replace: true })
  }

  const createAnother = () => {
    setView("form")
    setName("")
    setErrorMessage(null)
  }

  const backToCreated = () => {
    setView("success")
    setName("")
    setErrorMessage(null)
  }

  return (
    <div className="first-run">
      <svg className="first-run__ripple-field" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g fill="none" stroke="var(--ripple)" strokeWidth="1.5">
          <ellipse cx="600" cy="280" rx="150" ry="51" opacity=".16" />
          <ellipse cx="600" cy="280" rx="248" ry="84" opacity=".12" />
          <ellipse cx="600" cy="280" rx="360" ry="122" opacity=".085" />
          <ellipse cx="600" cy="280" rx="486" ry="165" opacity=".055" />
          <ellipse cx="600" cy="280" rx="600" ry="204" opacity=".03" />
        </g>
      </svg>

      <div className="first-run__topbar">
        <div className="first-run__brand">
          <img src="/logo.svg" alt="" className="first-run__brand-icon" />
          <span className="first-run__brand-name">Synk</span>
        </div>
      </div>

      <div className="first-run__stage">
        <div className="first-run__card">
          {view === "form" ? (
            <>
              {created && (
                <button type="button" className="first-run__back-link" onClick={backToCreated}>
                  <span className="first-run__arrow">←</span> Back to “{created.name}”
                </button>
              )}

              <div className="first-run__eyebrow">
                <svg width="13" height="16" viewBox="0 0 64 80" aria-hidden="true">
                  <path d="M32 4 C 33 26 48 38 48 52 a 16 16 0 1 1 -32 0 C 16 38 31 26 32 4 z" fill="var(--accent)" />
                </svg>
                New notebook
              </div>

              <h1 className="first-run__title">Name your notebook</h1>
              <p className="first-run__subtitle">Pick a name to get started — you can always change it later.</p>

              <input
                ref={inputRef}
                id="notebook-name"
                type="text"
                className={["first-run__input", errorMessage ? "is-error" : ""].join(" ")}
                placeholder="e.g. Research notes, Travel journal, Team wiki"
                value={name}
                autoComplete="off"
                spellCheck={false}
                maxLength={60}
                disabled={busy}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errorMessage) setErrorMessage(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreate()
                }}
              />
              {errorMessage && <span className="first-run__error">{errorMessage}</span>}

              <div className="first-run__secondary-field">
                <label className="first-run__secondary-label" htmlFor="your-name">
                  Your name <span className="first-run__secondary-hint">shown when collaborating</span>
                </label>
                <input
                  id="your-name"
                  type="text"
                  className="first-run__input first-run__input--secondary"
                  placeholder={identityPlaceholder.current}
                  value={yourName}
                  maxLength={40}
                  disabled={busy}
                  autoComplete="nickname"
                  spellCheck={false}
                  onChange={(e) => setYourName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") onCreate() }}
                />
              </div>

              <div className="first-run__actions">
                <button className="first-run__create-btn" disabled={busy} onClick={onCreate}>
                  {busy ? "Creating…" : "Create notebook"} <span className="first-run__arrow">→</span>
                </button>
                <span className="first-run__hint">or press ⏎ Enter</span>
              </div>

              <div className="first-run__footer">
                <span className="first-run__footer-dot" />
                Saved on this device · share it anytime to write together
              </div>
            </>
          ) : created ? (
            <div className="first-run__success">
              <div className="first-run__success-icon">
                <span className="first-run__ring" />
                <span className="first-run__ring first-run__ring--delay" />
                <span className="first-run__drop-wrap">
                  <svg width="26" height="32" viewBox="0 0 64 80" aria-hidden="true">
                    <path d="M32 4 C 33 26 48 38 48 52 a 16 16 0 1 1 -32 0 C 16 38 31 26 32 4 z" fill="var(--accent)" />
                  </svg>
                </span>
              </div>

              <h1 className="first-run__title first-run__title--success">“{created.name}” is ready</h1>
              <p className="first-run__subtitle first-run__subtitle--success">
                It's saved on this device. Share it whenever you're ready to write together.
              </p>

              <div className="first-run__success-actions">
                <button className="first-run__create-btn" onClick={openNotebook}>
                  Open notebook <span className="first-run__arrow">→</span>
                </button>
                <button className="first-run__secondary-btn" onClick={createAnother}>
                  Create another
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function SingleScreen() {
  const { currentNotebook, notebooks } = useNotebooks()
  const navigate = useNavigate()
  // While true, suppresses the auto-redirect below so the freshly-created
  // notebook's success screen in FirstRun has a chance to show.
  const [celebrating, setCelebrating] = React.useState(false)

  React.useEffect(() => {
    if (celebrating) return
    if (notebooks.length && currentNotebook) {
      navigate(`/nb/${currentNotebook.id}`, { replace: true })
    }
  }, [notebooks.length, currentNotebook, navigate, celebrating])

  if (!notebooks.length || !currentNotebook || celebrating) {
    return (
      <FirstRun
        onWillCreate={() => setCelebrating(true)}
        onDismiss={() => setCelebrating(false)}
      />
    )
  }

  // return null
  return <EditorScreen notebook={currentNotebook} />
}

function EditorScreen({ notebook }: { notebook: any }) {
const [noteId, setNoteId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const last = getLastOpenedNoteId(notebook.id)
    const fallbackFirst = findFirstNoteId(notebook.root)
    setNoteId(last || fallbackFirst || null)
    // Resolving the starting note is a one-shot per notebook; notebook.root is
    // read for its fallback only and deliberately not a dependency, or every
    // tree edit would yank the open note back to the start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook.id])

  //if (!noteId) return <div className="empty-content"><p>No note found. Create one from the sidebar.</p></div>
  return <NoteEditorPage notebookId={notebook.id} noteId={noteId ?? undefined} />
}

// Tiny helper to pick first note id from your local tree model
function findFirstNoteId(node: any): string | null {
  if (!node) return null
  if (!node.isFolder) return isNoteNode(node) ? node.id : null
  const children = node.children || []
  for (const c of children) {
    const id = findFirstNoteId(c)
    if (id) return id
  }
  return null
}

export default function App() {
  return (
      <NotebooksProvider>
        <SingleScreen />
      </NotebooksProvider>
  )
}