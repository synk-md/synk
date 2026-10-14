import * as React from "react"
import { useLocation } from "react-router-dom"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { useNotebooks } from "@/hooks/use-notebooks"
import { parseInvitationSecret } from "@/lib/directory"
import { currentDevice, deviceFingerprint } from "@/lib/identity"
import { encryptedSyncEnabled, pairingApproval, requestPairing, type PairedNotebook, type PairingApproval } from "@/lib/workspace"
import { fetchNotebook, openPairing, type PairingChannelHandle } from "@/lib/workspace/device-pairing"

import "./join-notebook-page.scss"

type Collected = PairedNotebook & { state: "waiting" | "ready" | "missing" }

/**
 * The new device's side of linking: ask, show the code, then collect every
 * notebook the other device linked it into.
 *
 * Collecting fetches each notebook's tree before adding it to this device's
 * list, rather than adding a placeholder - an empty tree written here could
 * race the real one and be saved over it.
 */
export function LinkDevicePage() {
  const location = useLocation()
  const { adoptNotebook } = useNotebooks()
  const [codeText, setCodeText] = React.useState(() => decodeURIComponent(location.hash.replace(/^#/, "")))
  const [stage, setStage] = React.useState<"entering" | "waiting" | "collecting" | "done">("entering")
  const [error, setError] = React.useState<string | null>(null)
  const [fingerprint, setFingerprint] = React.useState<string | null>(null)
  const [collected, setCollected] = React.useState<Collected[]>([])
  const [skipped, setSkipped] = React.useState<PairingApproval["skipped"]>([])
  const channel = React.useRef<PairingChannelHandle | null>(null)

  React.useEffect(() => {
    const device = currentDevice()
    if (device) void deviceFingerprint(device.identity.did).then(setFingerprint)
    return () => channel.current?.close()
  }, [])

  const collect = React.useCallback(
    async (approval: PairingApproval) => {
      const device = currentDevice()
      if (!device) return
      setStage("collecting")
      setSkipped(approval.skipped)
      setCollected(approval.notebooks.map((notebook) => ({ ...notebook, state: "waiting" })))
      for (const notebook of approval.notebooks) {
        const root = await fetchNotebook(notebook.id, device.identity).catch(() => null)
        if (root) adoptNotebook(notebook.id, root)
        setCollected((previous) =>
          previous.map((entry) => (entry.id === notebook.id ? { ...entry, state: root ? "ready" : "missing" } : entry)),
        )
      }
      channel.current?.close()
      channel.current = null
      setStage("done")
    },
    [adoptNotebook],
  )

  const ask = async () => {
    const device = currentDevice()
    if (!device) return
    setError(null)
    try {
      const handle = await openPairing(parseInvitationSecret(codeText.trim()), device.identity)
      channel.current = handle
      requestPairing(handle.doc, device.identity.record)
      setStage("waiting")
      let started = false
      const watch = () => {
        const approval = pairingApproval(handle.doc)
        if (!approval || started) return
        started = true
        handle.doc.off("update", watch)
        void collect(approval)
      }
      handle.doc.on("update", watch)
      watch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That code was not accepted.")
    }
  }

  if (!encryptedSyncEnabled()) {
    return (
      <main className="join-page">
        <h1>Linking needs sync switched on</h1>
        <p>The two devices meet through the sync service, and it is not configured here.</p>
      </main>
    )
  }

  return (
    <main className="join-page">
      {stage === "entering" ? (
        <>
          <h1>Link this device</h1>
          <p>
            This device will become another of your devices: it writes as you and sees what you see,
            in every notebook your other device links it into.
          </p>
          <label htmlFor="link-code" className="join-label">
            Linking code
          </label>
          <input
            id="link-code"
            autoComplete="off"
            spellCheck={false}
            value={codeText}
            onChange={(event) => setCodeText(event.target.value)}
            className="join-input"
          />
          {error && (
            <p className="join-error" role="alert">
              {error}
            </p>
          )}
          <Button className="join-button" disabled={codeText.trim().length === 0} onClick={() => void ask()}>
            <span className="tiptap-button-text">Ask to link</span>
          </Button>
        </>
      ) : stage === "waiting" ? (
        <>
          <h1>Confirm on your other device</h1>
          <p>Type this code into the other device. It will only link this one if the codes match.</p>
          <span className="join-label">This device&rsquo;s code</span>
          <code className="join-fingerprint" aria-label="This device's code">
            {fingerprint ?? "…"}
          </code>
          <p className="join-note">You can close this page and open the link again later.</p>
        </>
      ) : (
        <>
          <h1>{stage === "done" ? "Linked" : "Collecting your notebooks…"}</h1>
          <ul className="join-note" aria-label="Notebooks">
            {collected.map((notebook) => (
              <li key={notebook.id}>
                {notebook.name} -{" "}
                {notebook.state === "ready"
                  ? "ready"
                  : notebook.state === "missing"
                    ? "not available yet; open the link again later"
                    : "collecting…"}
              </li>
            ))}
            {skipped.map((notebook) => (
              <li key={notebook.id}>
                {notebook.name} - not linked: {notebook.reason}
              </li>
            ))}
          </ul>
          {stage === "done" && (
            <a className="join-link" href="/">
              Open your notebooks
            </a>
          )}
        </>
      )}
    </main>
  )
}

export default LinkDevicePage
