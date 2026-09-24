"use client"

import * as React from "react"

import type { Ability } from "@/lib/authz"
import type { Invitation, Redemption } from "@/lib/directory"
import { currentDevice } from "@/lib/identity"
import {
  admitFromRedemption,
  invitationsInDoc,
  inviteToNotebook,
  pendingRedemptions,
  readNotebookWorkspace,
  type NotebookWorkspace,
} from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

/** A redemption paired with the invitation it claims, ready to approve. */
export interface PendingJoin {
  invitation: Invitation
  redemption: Redemption
}

export interface NotebookMembers {
  workspace: NotebookWorkspace | null
  invitations: Invitation[]
  /** Redemptions with no admission yet. What the owner is being asked to decide. */
  awaiting: PendingJoin[]
  loading: boolean
  /** True when this device is the owner, so it may invite and admit. */
  canAdmit: boolean
  invite: (request: { secret: Uint8Array; member: string; label: string }) => Promise<Invitation>
  admit: (pending: PendingJoin, ability?: Ability) => Promise<void>
  reject: (pending: PendingJoin) => void
}

/**
 * The owner's view of who is in a notebook and who is asking to be.
 *
 * Everything is re-read from the document on every change rather than cached.
 * A pending join is a redemption with no admission behind it, which is derived
 * rather than tracked: a grant that arrives from another of the owner's devices
 * makes the row disappear here with no bookkeeping.
 */
export function useNotebookMembers(notebookId: string | null): NotebookMembers {
  const [workspace, setWorkspace] = React.useState<NotebookWorkspace | null>(null)
  const [invitations, setInvitations] = React.useState<Invitation[]>([])
  const [awaiting, setAwaiting] = React.useState<PendingJoin[]>([])
  const [loading, setLoading] = React.useState(true)
  const [rejected, setRejected] = React.useState<Set<string>>(new Set())

  const device = currentDevice()
  const selfDid = device?.identity.did

  const refresh = React.useCallback(() => {
    if (!notebookId) {
      setWorkspace(null)
      setLoading(false)
      return
    }
    const { doc } = createNotebookIndexDoc(notebookId)
    const issued = invitationsInDoc(doc)
    const byId = new Map(issued.map((invitation) => [invitation.invitationId, invitation]))

    setInvitations(issued)
    setAwaiting(
      pendingRedemptions(doc)
        .filter((redemption) => !rejected.has(redemption.did))
        .flatMap((redemption) => {
          const invitation = byId.get(redemption.invitationId)
          // A redemption naming an invitation this notebook never issued is
          // dropped rather than shown: there is nothing to approve it against.
          return invitation ? [{ invitation, redemption }] : []
        }),
    )

    void readNotebookWorkspace({
      doc,
      notebookId,
      ...(selfDid === undefined ? {} : { selfDid }),
    })
      .then((next) => {
        setWorkspace(next)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [notebookId, selfDid, rejected])

  React.useEffect(() => {
    if (!notebookId) return
    const { doc, idb } = createNotebookIndexDoc(notebookId)
    void idb.whenSynced.then(refresh)
    doc.on("update", refresh)
    return () => {
      doc.off("update", refresh)
    }
  }, [notebookId, refresh])

  const canAdmit = Boolean(
    notebookId && selfDid && workspace?.ownership.owner === selfDid,
  )

  const invite = React.useCallback(
    async (request: { secret: Uint8Array; member: string; label: string }) => {
      if (!notebookId || !device) throw new Error("no notebook or device identity")
      const { doc } = createNotebookIndexDoc(notebookId)
      const invitation = await inviteToNotebook({
        doc,
        notebookId,
        admin: { signingKey: device.identity.signingKey, did: device.identity.did },
        secret: request.secret,
        label: request.label,
        member: request.member,
      })
      refresh()
      return invitation
    },
    [notebookId, device, refresh],
  )

  const admit = React.useCallback(
    async (pending: PendingJoin, ability: Ability = "write") => {
      if (!notebookId || !device) throw new Error("no notebook or device identity")
      const { doc } = createNotebookIndexDoc(notebookId)
      await admitFromRedemption({
        doc,
        notebookId,
        owner: device.identity,
        invitation: pending.invitation,
        redemption: pending.redemption,
        ability,
      })
      refresh()
    },
    [notebookId, device, refresh],
  )

  // Rejection is local and deliberately not a record: refusing to admit someone
  // is the absence of a grant, and publishing "I said no" would leak the
  // decision to everyone who can read the notebook.
  const reject = React.useCallback((pending: PendingJoin) => {
    setRejected((previous) => new Set(previous).add(pending.redemption.did))
  }, [])

  return {
    workspace,
    invitations,
    awaiting,
    loading,
    canAdmit,
    invite,
    admit,
    reject,
  }
}
