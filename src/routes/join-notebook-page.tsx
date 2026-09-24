import * as React from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { WebrtcProvider } from "y-webrtc"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { parseInvitationSecret } from "@/lib/directory"
import { currentDevice } from "@/lib/identity"
import { readNotebookKeys, readNotebookWorkspace, redeemIntoNotebook } from "@/lib/workspace"
import { createNotebookIndexDoc, keyForIndex, SIGNALING_SERVERS } from "@/lib/yjs-utils"

import "./join-notebook-page.scss"

type Stage = "entering" | "redeeming" | "waiting" | "joined" | "failed"

/**
 * The invitee's side of an invitation.
 *
 * Two things arrive by different routes and both are needed: the link, which
 * says which notebook, and the code, which proves you are the person it was
 * addressed to. The page asks for the code precisely because the link cannot
 * carry it - a link that did would hand the notebook to anyone who saw it.
 *
 * Redeeming is not joining. It publishes a proof and then waits for the owner
 * to grant, which is a separate act by a separate person, so the page says so
 * rather than spinning as though something is loading.
 */
export function JoinNotebookPage() {
  const { notebookId } = useParams<{ notebookId: string }>()
  const [params] = useSearchParams()
  const [secretText, setSecretText] = React.useState("")
  const [stage, setStage] = React.useState<Stage>("entering")
  const [error, setError] = React.useState<string | null>(null)
  const [label, setLabel] = React.useState<string | null>(null)

  // Connect to the notebook's index room so the redemption reaches the owner
  // and their grant reaches back.
  React.useEffect(() => {
    if (!notebookId) return
    const { doc } = createNotebookIndexDoc(notebookId)
    const room = keyForIndex(notebookId)
    const provider = new WebrtcProvider(room, doc, {
      signaling: SIGNALING_SERVERS,
      password: room,
    })
    return () => {
      provider.disconnect()
      provider.destroy()
    }
  }, [notebookId])

  // Once redeemed, watch for the grant rather than asking the person to reload.
  React.useEffect(() => {
    if (stage !== "waiting" || !notebookId) return
    const device = currentDevice()
    if (!device) return

    const { doc } = createNotebookIndexDoc(notebookId)
    const check = () => {
      void readNotebookWorkspace({ doc, notebookId, selfDid: device.identity.did })
        .then(async (workspace) => {
          if (!workspace.self || !workspace.ownership.owner) return
          const keys = await readNotebookKeys({
            doc,
            notebookId,
            device: device.identity,
            owner: workspace.ownership.owner,
          })
          // Admitted *and* able to read. Either alone would be a half-join.
          if (keys.access === "reader") setStage("joined")
        })
        .catch(() => undefined)
    }
    doc.on("update", check)
    check()
    return () => {
      doc.off("update", check)
    }
  }, [stage, notebookId])

  const redeem = async () => {
    const device = currentDevice()
    if (!notebookId || !device) {
      setError("This device has no identity yet. Reload and try again.")
      setStage("failed")
      return
    }
    setStage("redeeming")
    setError(null)
    try {
      const secret = parseInvitationSecret(secretText.trim())
      const { doc } = createNotebookIndexDoc(notebookId)
      await redeemIntoNotebook({ doc, secret, device: device.identity })
      setStage("waiting")
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That code was not accepted. Check it and try again.",
      )
      setStage("entering")
    }
  }

  React.useEffect(() => {
    const invited = params.get("for")
    if (invited) setLabel(invited)
  }, [params])

  if (!notebookId) {
    return (
      <main className="join-page">
        <h1>That link is not a notebook invitation.</h1>
      </main>
    )
  }

  return (
    <main className="join-page">
      {stage === "joined" ? (
        <>
          <h1>You are in.</h1>
          <p>
            You now have the keys to this notebook. Anything written from here on is readable to
            you; anything written before you joined is not.
          </p>
          <a className="join-link" href={`/nb/${notebookId}`}>
            Open the notebook
          </a>
        </>
      ) : stage === "waiting" ? (
        <>
          <h1>Waiting to be let in</h1>
          <p>
            Your request has been sent. Whoever invited you has to approve it — they will be asked
            to check a short code against the one your device shows, so they know it is you.
          </p>
          <p className="join-note">
            You can close this page. Come back to the same link and you will see where things
            stand.
          </p>
        </>
      ) : (
        <>
          <h1>Join this notebook{label ? ` as ${label}` : ""}</h1>
          <p>
            You were sent a one-time code separately from this link. Both are needed: the link says
            which notebook, the code proves it is you.
          </p>

          <label htmlFor="join-code" className="join-label">
            One-time code
          </label>
          <input
            id="join-code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={secretText}
            onChange={(event) => {
              setSecretText(event.target.value)
              if (error) setError(null)
            }}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            className="join-input"
            disabled={stage === "redeeming"}
            onKeyDown={(event) => {
              if (event.key === "Enter") void redeem()
            }}
          />

          {error && (
            <p className="join-error" role="alert">
              {error}
            </p>
          )}

          <Button
            className="join-button"
            disabled={secretText.trim().length === 0 || stage === "redeeming"}
            onClick={() => void redeem()}
          >
            <span className="tiptap-button-text">
              {stage === "redeeming" ? "Sending…" : "Ask to join"}
            </span>
          </Button>
        </>
      )}
    </main>
  )
}

export default JoinNotebookPage
