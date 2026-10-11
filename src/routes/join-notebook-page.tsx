import * as React from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { WebrtcProvider } from "y-webrtc"

import { Button } from "@/components/tiptap-ui-primitive/button"
import { parseInvitationSecret } from "@/lib/directory"
import { currentDevice, deviceFingerprint } from "@/lib/identity"
import {
  genesisClaims,
  matchInvitation,
  readNotebookKeys,
  readNotebookWorkspace,
  redeemIntoNotebook,
} from "@/lib/workspace"
import { createNotebookIndexDoc, keyForIndex, SIGNALING_SERVERS } from "@/lib/yjs-utils"

import { waitingMessage } from "./join-waiting-message"

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
  const [fingerprint, setFingerprint] = React.useState<string | null>(null)
  // Learned from the invitation the code points at, not from the notebook.
  const [expectedOwner, setExpectedOwner] = React.useState<string | null>(null)
  // Whether the notebook has reached this device at all. A code checked against
  // an empty document always fails, and reporting that as a wrong code is how
  // somebody ends up retyping a correct one.
  const [notebookReady, setNotebookReady] = React.useState(false)
  const [waitedTooLong, setWaitedTooLong] = React.useState(false)
  // Why nothing is arriving, which is a different question from whether
  // anything has. Unreachable signaling and an absent owner both look like
  // waiting, and only one of them is the waiting person's problem.
  const [transport, setTransport] = React.useState({ signaling: false, peers: 0 })

  // The owner is asked to compare this against what their screen derives from
  // the redemption. Without it on screen here there is nothing to compare, and
  // the check they are being asked to make would be theatre.
  React.useEffect(() => {
    const device = currentDevice()
    if (!device) return
    let cancelled = false
    void deviceFingerprint(device.identity.did).then((code) => {
      if (!cancelled) setFingerprint(code)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Wait for the notebook itself to arrive.
   *
   * A genesis claim is the signal: it is the first thing the owner wrote, so
   * its presence means their document has reached us and the invitation will
   * be here too.
   */
  React.useEffect(() => {
    if (!notebookId) return
    const { doc, idb } = createNotebookIndexDoc(notebookId)
    let cancelled = false

    const check = () => {
      if (!cancelled && genesisClaims(doc).length > 0) setNotebookReady(true)
    }
    void idb.whenSynced.then(check)
    doc.on("update", check)
    check()

    // Long enough that an ordinary connection is not interrupted, short enough
    // that somebody staring at a spinner is told why.
    const timer = setTimeout(() => {
      if (!cancelled) setWaitedTooLong(true)
    }, 15_000)

    return () => {
      cancelled = true
      clearTimeout(timer)
      doc.off("update", check)
    }
  }, [notebookId])

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

    const onPeers = (event: { webrtcPeers: string[]; bcPeers: string[] }) => {
      const peers = event.webrtcPeers.length + event.bcPeers.length
      setTransport((prev) => (prev.peers === peers ? prev : { ...prev, peers }))
    }
    provider.on("peers", onPeers)

    // Signaling state is not observable on the provider, so it is sampled.
    const conns = provider.signalingConns as { connected: boolean }[]
    const poll = setInterval(() => {
      const signaling = conns.some((conn) => conn.connected)
      setTransport((prev) => (prev.signaling === signaling ? prev : { ...prev, signaling }))
    }, 1000)

    return () => {
      clearInterval(poll)
      provider.off("peers", onPeers)
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
      void readNotebookWorkspace({
        doc,
        notebookId,
        selfDid: device.identity.did,
        ...(expectedOwner === null ? {} : { expectedOwner }),
      })
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
  }, [stage, notebookId, expectedOwner])

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

      // The code names an invitation, and the invitation names the admin who
      // signed it. Checking the notebook's own genesis against that is what
      // stops this being trust-on-first-use in whatever document turned up.
      const match = await matchInvitation(doc, secret)
      if (!match) {
        // Two very different failures, and conflating them sends somebody off
        // to re-check a code that was right all along.
        throw new Error(
          notebookReady
            ? "That code does not match an invitation to this notebook. Check the link and the code came from the same person."
            : "This notebook has not reached your device yet, so there is nothing to check the code against. Whoever invited you needs it open.",
        )
      }

      const workspace = await readNotebookWorkspace({
        doc,
        notebookId,
        expectedOwner: match.expectedOwner,
      })
      if (workspace.ownership.status !== "established") {
        throw new Error(
          "This notebook does not agree about who owns it. The invitation was signed by someone the notebook does not name as its owner — do not continue.",
        )
      }

      setExpectedOwner(match.expectedOwner)
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

  const waitingReason = waitingMessage({ waitedTooLong, ...transport })

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
            Your request has been sent. Whoever invited you now has to approve it, and they will
            ask you for the code below — read it out to them over a call or in person, not in the
            same place you were sent the link.
          </p>

          <span className="join-label">Your device code</span>
          <code className="join-fingerprint" aria-label="Your device code">
            {fingerprint ?? "…"}
          </code>
          <p className="join-note">
            It identifies this device specifically. If the code they see does not match this one,
            they are not talking to you and should refuse.
          </p>

          <p className="join-note">
            You can leave this page open. It will say so here once you have been let in.
          </p>
        </>
      ) : (
        <>
          <h1>Join this notebook{label ? ` as ${label}` : ""}</h1>
          <p>
            You were sent a one-time code separately from this link. Both are needed: the link says
            which notebook, the code proves it is you.
          </p>

          {!notebookReady && (
            <p className="join-note" role="status">
              {waitingReason}
            </p>
          )}

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
            disabled={secretText.trim().length === 0 || stage === "redeeming" || !notebookReady}
            onClick={() => void redeem()}
          >
            <span className="tiptap-button-text">
              {stage === "redeeming"
                ? "Sending…"
                : notebookReady
                  ? "Ask to join"
                  : "Waiting for the notebook…"}
            </span>
          </Button>
        </>
      )}
    </main>
  )
}

export default JoinNotebookPage
