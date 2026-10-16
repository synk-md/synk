import * as React from "react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { RecoveryCodeDialog } from "@/components/custom-ui/recovery/recovery-code-dialog"
import { useNotebooks } from "@/hooks/use-notebooks"
import { currentDevice } from "@/lib/identity"
import { encryptedSyncEnabled, parseRecoveryCode } from "@/lib/workspace"
import { recoverNotebook } from "@/lib/workspace/device-pairing"

import "./join-notebook-page.scss"

type Stage = "entering" | "recovering" | "saving" | "done"

/**
 * Getting a notebook back with its recovery code, on a device that may hold
 * nothing of it: this device becomes the owner, opens every key through the
 * copies sealed to the code, and is handed the code that replaces it.
 */
export function RecoverNotebookPage() {
  const { adoptNotebook } = useNotebooks()
  const [codeText, setCodeText] = React.useState("")
  const [stage, setStage] = React.useState<Stage>("entering")
  const [error, setError] = React.useState<string | null>(null)
  const [next, setNext] = React.useState<string | null>(null)
  const [notebookId, setNotebookId] = React.useState<string | null>(null)

  if (!encryptedSyncEnabled()) {
    return (
      <main className="join-page">
        <h1>Recovery needs sync switched on</h1>
        <p>The notebook comes back from the sync service, and it is not configured here.</p>
      </main>
    )
  }

  const recover = async () => {
    const device = currentDevice()
    if (!device) return
    setError(null)
    setStage("recovering")
    try {
      const code = parseRecoveryCode(codeText)
      const { root, next: replacement } = await recoverNotebook({ code, device: device.identity })
      if (root) adoptNotebook(code.notebookId, root)
      setNotebookId(code.notebookId)
      setNext(replacement.text)
      setStage("saving")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work. Check the code and try again.")
      setStage("entering")
    }
  }

  return (
    <main className="join-page">
      {stage === "entering" || stage === "recovering" ? (
        <>
          <h1>Recover a notebook</h1>
          <p>
            Enter the recovery code you saved when the notebook was created. This device becomes its owner, with
            everything written in it, and the device that owned it before is taken out.
          </p>
          <label htmlFor="recovery-code" className="join-label">
            Recovery code
          </label>
          <input
            id="recovery-code"
            className="join-input"
            value={codeText}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCodeText(event.target.value)}
          />
          {error && (
            <p className="join-error" role="alert">
              {error}
            </p>
          )}
          <Button
            className="join-button"
            disabled={codeText.trim().length === 0 || stage === "recovering"}
            onClick={() => void recover()}
          >
            <span className="tiptap-button-text">{stage === "recovering" ? "Recovering…" : "Recover"}</span>
          </Button>
        </>
      ) : (
        <>
          <h1>Recovered</h1>
          <p>This device owns the notebook now.</p>
          {notebookId && (
            <a className="join-link" href={`/nb/${notebookId}`}>
              Open the notebook
            </a>
          )}
        </>
      )}
      {stage === "saving" && next && (
        <RecoveryCodeDialog code={next} reason="next" onDone={() => setStage("done")} />
      )}
    </main>
  )
}

export default RecoverNotebookPage
