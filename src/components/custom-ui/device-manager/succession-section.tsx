"use client"

import * as React from "react"
import { RiShieldUserLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import type { MemberDevice, User } from "@/lib/identity"
import type { DeviceIdentity } from "@/lib/identity"
import { isStandby, type PairedNotebook } from "@/lib/workspace"
import { nameStandbyEverywhere, takeOverEverywhere } from "@/lib/workspace/device-pairing"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

export type SuccessionSectionProps = {
  notebookId: string
  owner: string | null
  device: DeviceIdentity
  user: User
  notebooks: readonly PairedNotebook[]
}

// A link carries no name of its own; the end of its key tells two apart.
const nameOf = (device: MemberDevice) =>
  device.kind === "linked" ? `Linked device ${device.record.did.slice(-6)}` : device.admission.label

/**
 * What happens if a device is lost: the owner names one of their devices as
 * able to take over, and that device, if it comes to it, takes over.
 */
export function SuccessionSection({ notebookId, owner, device, user, notebooks }: SuccessionSectionProps) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const { doc } = createNotebookIndexDoc(notebookId)

  if (!owner) return null
  const self = device.did

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key)
    setResult(null)
    try {
      setResult(await action())
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : "That did not go through.")
    } finally {
      setBusy(null)
    }
  }

  if (self === owner) {
    const others = user.devices.filter((entry) => entry.kind === "linked")
    return (
      <section className="dm-section" aria-labelledby="succession-heading">
        <h4 id="succession-heading" className="dm-section-title">
          <RiShieldUserLine aria-hidden="true" /> If this device is lost
        </h4>
        <p className="dm-body-text">
          Let one of your other devices take over as owner, so losing this one does not leave nobody able to run the
          notebook. Your recovery code works too, even if every device is gone.
        </p>
        {others.length === 0 ? (
          <p className="dm-subtle">Link another device first.</p>
        ) : (
          <ul className="dm-list">
            {others.map((entry) => {
              const named = isStandby(doc, owner, entry.record.did)
              return (
                <li key={entry.record.did} className="dm-row">
                  <span>{nameOf(entry)}</span>
                  {named ? (
                    <span className="dm-subtle">Can take over</span>
                  ) : (
                    <Button
                      data-style="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(entry.record.did, async () => {
                          const done = await nameStandbyEverywhere({ device, standby: entry.record.did, notebooks })
                          return `It can now take over ${String(done.length)} notebook${done.length === 1 ? "" : "s"}.`
                        })
                      }
                    >
                      <span className="tiptap-button-text">{busy === entry.record.did ? "Saving…" : "Let it take over"}</span>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {result && <p className="dm-subtle" role="status">{result}</p>}
      </section>
    )
  }

  if (!isStandby(doc, owner, self)) return null

  return (
    <section className="dm-section" aria-labelledby="succession-heading">
      <h4 id="succession-heading" className="dm-section-title">
        <RiShieldUserLine aria-hidden="true" /> Take over as owner
      </h4>
      <p className="dm-body-text">
        The owner named this device as able to take over. Do this only if the device that owns these notebooks is lost:
        it is taken out of them, everything it did stays, and their keys are replaced so it can read nothing new.
      </p>
      {confirming ? (
        <div className="dm-actions">
          <Button data-style="ghost" onClick={() => setConfirming(false)}>
            <span className="tiptap-button-text">Not now</span>
          </Button>
          <Button
            className="dm-primary-btn is-active is-danger"
            disabled={busy !== null}
            onClick={() =>
              void run("take-over", async () => {
                const { taken, failed } = await takeOverEverywhere({ device, notebooks })
                setConfirming(false)
                return failed.length > 0
                  ? `Took over ${String(taken.length)}; ${String(failed.length)} could not be: ${failed.map((each) => each.reason).join("; ")}`
                  : `You own ${String(taken.length)} notebook${taken.length === 1 ? "" : "s"} now.`
              })
            }
          >
            <span className="tiptap-button-text">{busy ? "Taking over…" : "The owner's device is lost — take over"}</span>
          </Button>
        </div>
      ) : (
        <div className="dm-actions">
          <Button data-style="ghost" onClick={() => setConfirming(true)}>
            <span className="tiptap-button-text">Take over as owner</span>
          </Button>
        </div>
      )}
      {result && <p className="dm-subtle" role="status">{result}</p>}
    </section>
  )
}

export default SuccessionSection
