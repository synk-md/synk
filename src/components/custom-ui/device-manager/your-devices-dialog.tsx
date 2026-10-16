"use client"

import * as React from "react"

import { useNotebookWorkspace } from "@/hooks/use-notebook-workspace"
import { useNotebooks } from "@/hooks/use-notebooks"
import { currentDevice, type MemberDevice } from "@/lib/identity"
import { unlinkEverywhere } from "@/lib/workspace/device-pairing"

import { DeviceManagerDialog } from "./device-manager-dialog"
import { SuccessionSection } from "./succession-section"

export type YourDevicesDialogProps = {
  open: boolean
  onClose: () => void
  /** Whose directory to read your devices from. */
  notebookId: string | null
}

/**
 * Your devices, read from the open notebook, and taking one out of all of them.
 *
 * Only devices you linked can be taken out here, and only from one the owner
 * approved: an approved device goes only with its person. What removing does
 * is said as it is - the key can only be replaced by the owner's device.
 */
export function YourDevicesDialog({ open, onClose, notebookId }: YourDevicesDialogProps) {
  const { workspace } = useNotebookWorkspace(open ? notebookId : null)
  const { notebooks } = useNotebooks()
  const device = currentDevice()
  const self = device?.identity.did
  const me = workspace?.users.find((user) => user.devices.some((entry) => entry.record.did === self)) ?? null
  const approvedHere = me?.devices.some((entry) => entry.kind === "admitted" && entry.record.did === self) ?? false
  const owner = workspace?.ownership.owner === self

  const revoke = React.useCallback(
    async (target: MemberDevice) => {
      if (!device) return
      await unlinkEverywhere({
        device: device.identity,
        did: target.record.did,
        notebooks: notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name })),
      })
    },
    [device, notebooks],
  )

  if (!open || !me) return null

  return (
    <DeviceManagerDialog
      open
      onClose={onClose}
      user={me}
      {...(approvedHere ? { onRevoke: revoke } : {})}
      canRevoke={(entry) => entry.kind === "linked"}
      removalNote={
        owner
          ? "Remove this device from every notebook? Its edits stop being accepted at once, and the key is replaced now, so it can read nothing written from here on."
          : "Remove this device from every notebook? Its edits stop being accepted at once. It can still read new writing until each notebook's owner next opens it, which replaces the key."
      }
    >
      {notebookId && device && (
        <SuccessionSection
          notebookId={notebookId}
          owner={workspace?.ownership.owner ?? null}
          device={device.identity}
          user={me}
          notebooks={notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name }))}
        />
      )}
    </DeviceManagerDialog>
  )
}

export default YourDevicesDialog
