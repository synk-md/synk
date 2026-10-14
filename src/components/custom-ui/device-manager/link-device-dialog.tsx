"use client"

import * as React from "react"
import { RiCheckLine, RiCloseLine, RiFileCopyLine, RiLinkM } from "@remixicon/react"

import { FingerprintCompare } from "@/components/custom-ui/identity/fingerprint-compare"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { useNotebooks } from "@/hooks/use-notebooks"
import { generateInvitationSecret } from "@/lib/directory"
import { currentDevice, verifyDeviceRecord } from "@/lib/identity"
import {
  approvePairing,
  encryptedSyncEnabled,
  pairingRequest,
  type PairedNotebook,
  type PairingRequest,
} from "@/lib/workspace"
import { linkEverywhere, openPairing, type PairingChannelHandle } from "@/lib/workspace/device-pairing"

import "@/components/custom-ui/invitations/invitations.scss"
import "@/components/custom-ui/members/members.scss"

export type LinkDeviceDialogProps = {
  open: boolean
  onClose: () => void
}

type Stage =
  | { kind: "waiting" }
  | { kind: "review"; request: PairingRequest }
  | { kind: "linking"; done: number; total: number; current: string }
  | { kind: "linked"; linked: PairedNotebook[]; skipped: (PairedNotebook & { reason: string })[] }
  | { kind: "failed"; message: string }

/**
 * Using your notebooks on another device, as you.
 *
 * Inviting your phone would make it a second member: counted twice, removed
 * separately, and seeing only from today. Linking makes it another of your
 * devices - it writes under your access and sees what you see.
 *
 * The link gets the new device into a meeting place and nothing more. What
 * lets it in is you typing the code it shows into this screen, which is why a
 * leaked link admits nobody.
 */
export function LinkDeviceDialog({ open, onClose }: LinkDeviceDialogProps) {
  const { notebooks } = useNotebooks()
  const [stage, setStage] = React.useState<Stage>({ kind: "waiting" })
  const [code, setCode] = React.useState<string | null>(null)
  const [matched, setMatched] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const channel = React.useRef<PairingChannelHandle | null>(null)

  React.useEffect(() => {
    const device = currentDevice()
    if (!open || !device || !encryptedSyncEnabled()) return
    const { secret, text } = generateInvitationSecret()
    setCode(text)
    setStage({ kind: "waiting" })
    setMatched(false)
    let cancelled = false
    let stop: (() => void) | undefined

    void openPairing(secret, device.identity)
      .then((handle) => {
        if (cancelled) {
          handle.close()
          return
        }
        channel.current = handle
        const watch = () => {
          const request = pairingRequest(handle.doc)
          if (!request) return
          // A record that does not verify is not a device asking; it is noise.
          void verifyDeviceRecord(request.record).then((valid) => {
            if (valid && !cancelled) setStage((previous) => (previous.kind === "waiting" ? { kind: "review", request } : previous))
          })
        }
        handle.doc.on("update", watch)
        watch()
        stop = () => {
          handle.doc.off("update", watch)
          handle.close()
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setStage({ kind: "failed", message: error instanceof Error ? error.message : "Could not start linking." })
      })

    return () => {
      cancelled = true
      stop?.()
      channel.current = null
    }
  }, [open])

  if (!open) return null

  const link = code ? `${window.location.origin}/link#${code}` : ""

  const approve = async (request: PairingRequest) => {
    const device = currentDevice()
    const handle = channel.current
    if (!device || !handle) return
    setStage({ kind: "linking", done: 0, total: notebooks.length, current: "" })
    try {
      const result = await linkEverywhere({
        device: device.identity,
        record: request.record,
        notebooks: notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name })),
        onProgress: (done, total, current) => setStage({ kind: "linking", done, total, current: current.name }),
      })
      approvePairing(handle.doc, {
        by: device.identity.did,
        notebooks: result.linked,
        skipped: result.skipped,
        approvedAt: Date.now(),
      })
      setStage({ kind: "linked", ...result })
    } catch (error) {
      setStage({ kind: "failed", message: error instanceof Error ? error.message : "Could not link the device." })
    }
  }

  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
  }

  return (
    <div
      className="mem-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && stage.kind !== "linking") onClose()
      }}
    >
      <div className="mem-dialog" role="dialog" aria-modal="true" aria-labelledby="link-device-heading">
        <div className="mem-header">
          <h3 id="link-device-heading">Link another device</h3>
          <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose} disabled={stage.kind === "linking"}>
            <RiCloseLine className="tiptap-button-icon" />
          </Button>
        </div>

        {!encryptedSyncEnabled() ? (
          <p className="inv-body-text">Linking devices needs sync switched on, so the two can meet.</p>
        ) : stage.kind === "waiting" ? (
          <>
            <p className="inv-body-text">
              Open this link on the device you want to use. It becomes another of your devices: it
              writes as you and sees what you see, rather than joining as someone new.
            </p>
            <div className="inv-share-step">
              <div className="inv-share-body">
                <span className="inv-field-label">
                  <RiLinkM aria-hidden="true" /> Linking link
                </span>
                <code className="inv-share-value" aria-label="Linking link">
                  {link || "…"}
                </code>
                <Button data-style="ghost" onClick={() => void copy()} disabled={!link}>
                  {copied ? <RiCheckLine className="tiptap-button-icon" /> : <RiFileCopyLine className="tiptap-button-icon" />}
                  <span className="tiptap-button-text">{copied ? "Copied link" : "Copy link"}</span>
                </Button>
              </div>
            </div>
            <p className="inv-body-text inv-muted" role="status">
              Waiting for the other device. You will be asked to confirm the code it shows before
              anything is shared with it.
            </p>
          </>
        ) : stage.kind === "review" ? (
          <>
            <p className="inv-body-text">
              A device has asked to be linked. Compare the code it shows with what you type here -
              if they differ, it is not your device.
            </p>
            <FingerprintCompare
              did={stage.request.record.did}
              onMatchChange={setMatched}
              inputId="link-device-code"
              prompt="Type the code your other device shows"
              mismatchGuidance="If the codes differ, someone else opened the link. Close this and start again."
            />
            <div className="inv-actions">
              <Button data-style="ghost" onClick={onClose}>
                <span className="tiptap-button-text">Cancel</span>
              </Button>
              <Button
                className={["inv-primary-btn", matched ? "is-active" : ""].join(" ")}
                disabled={!matched}
                onClick={() => void approve(stage.request)}
              >
                <span className="tiptap-button-text">Link this device</span>
              </Button>
            </div>
          </>
        ) : stage.kind === "linking" ? (
          <p className="inv-body-text" role="status">
            Linking into your notebooks — {String(stage.done)} of {String(stage.total)}
            {stage.current ? `: ${stage.current}` : ""}. Keep this open until it finishes.
          </p>
        ) : stage.kind === "linked" ? (
          <>
            <p className="inv-body-text" role="status">
              {stage.linked.length === 1
                ? "Linked into 1 notebook."
                : `Linked into ${String(stage.linked.length)} notebooks.`}{" "}
              The other device is collecting them now.
            </p>
            {stage.skipped.length > 0 && (
              <ul className="inv-body-text inv-muted">
                {stage.skipped.map((notebook) => (
                  <li key={notebook.id}>
                    {notebook.name}: {notebook.reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="inv-actions">
              <Button className="inv-primary-btn is-active" onClick={onClose}>
                <span className="tiptap-button-text">Done</span>
              </Button>
            </div>
          </>
        ) : (
          <p className="inv-error" role="alert">
            {stage.message}
          </p>
        )}
      </div>
    </div>
  )
}

export default LinkDeviceDialog
