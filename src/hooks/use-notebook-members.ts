"use client"

import * as React from "react"

import type { Ability } from "@/lib/authz"
import type { Invitation, Redemption } from "@/lib/directory"
import { currentDevice } from "@/lib/identity"
import {
  admitFromRedemption,
  cancelInvitation,
  forgetInvitationCode,
  grantedInvitationIds,
  invitationRevocationsInDoc,
  invitationsInDoc,
  inviteToNotebook,
  recallInvitationCode,
  rememberInvitationCode,
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
  invite: (request: {
    secret: Uint8Array
    text: string
    member: string
    label: string
  }) => Promise<Invitation>
  admit: (pending: PendingJoin, ability?: Ability) => Promise<{ epoch: number } | null>
  reject: (pending: PendingJoin) => void
  /** Withdraw an invitation. Also forgets its stored code. */
  cancel: (invitation: Invitation) => Promise<void>
  /** The code for an outstanding invitation, if this device issued it. */
  codeFor: (invitation: Invitation) => string | null
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
    const cancelled = new Set(
      invitationRevocationsInDoc(doc).map((revocation) => revocation.invitationId),
    )
    // A withdrawn invitation stops being offered, and so does anything redeemed
    // against it - approving one would fail at the grant anyway.
    //
    // A granted one goes too. It is no longer outstanding, and leaving it under
    // "Sent" would read as somebody still expected when they have already
    // joined - the member list above is where they are now recorded.
    const granted = grantedInvitationIds(doc)
    const issued = invitationsInDoc(doc).filter(
      (invitation) =>
        !cancelled.has(invitation.invitationId) && !granted.has(invitation.invitationId),
    )
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
    async (request: { secret: Uint8Array; text: string; member: string; label: string }) => {
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
      // Kept on this device only. It is never written to the notebook, which
      // syncs to everyone and would hand the code to the very people it is
      // meant to distinguish between.
      rememberInvitationCode(notebookId, invitation.invitationId, request.text)
      refresh()
      return invitation
    },
    [notebookId, device, refresh],
  )

  const admit = React.useCallback(
    async (pending: PendingJoin, ability: Ability = "write") => {
      if (!notebookId || !device) throw new Error("no notebook or device identity")
      const { doc } = createNotebookIndexDoc(notebookId)
      const granted = await admitFromRedemption({
        doc,
        notebookId,
        owner: device.identity,
        invitation: pending.invitation,
        redemption: pending.redemption,
        ability,
      })
      forgetInvitationCode(notebookId, pending.invitation.invitationId)
      refresh()
      return { epoch: granted.epoch }
    },
    [notebookId, device, refresh],
  )

  // Rejection is local and deliberately not a record: refusing to admit someone
  // is the absence of a grant, and publishing "I said no" would leak the
  // decision to everyone who can read the notebook.
  const reject = React.useCallback((pending: PendingJoin) => {
    setRejected((previous) => new Set(previous).add(pending.redemption.did))
  }, [])

  const cancel = React.useCallback(
    async (invitation: Invitation) => {
      if (!notebookId || !device) throw new Error("no notebook or device identity")
      const { doc } = createNotebookIndexDoc(notebookId)
      await cancelInvitation({
        doc,
        admin: { signingKey: device.identity.signingKey, did: device.identity.did },
        invitation,
      })
      // Past this point the code can do nothing, and keeping it is the only
      // version of storing it that has a downside and no upside.
      forgetInvitationCode(notebookId, invitation.invitationId)
      refresh()
    },
    [notebookId, device, refresh],
  )

  return {
    workspace,
    invitations,
    awaiting,
    loading,
    canAdmit,
    invite,
    admit,
    reject,
    cancel,
    codeFor: (invitation: Invitation) =>
      notebookId ? recallInvitationCode(notebookId, invitation.invitationId) : null,
  }
}
