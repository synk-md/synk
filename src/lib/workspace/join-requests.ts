/**
 * Asking to join, on a channel of the invitation's own.
 *
 * The directory takes writes from the owner and members only, so somebody not
 * yet in cannot leave their request there. They leave it on a channel derived
 * from the invitation, and any of the owner's devices with the notebook open
 * copies it across. Only a request that proves it holds the invitation's code
 * is copied, so whatever else lands on that channel goes nowhere.
 *
 * The channel is named by the invitation's id, which every reader of the
 * directory can see - so all of the owner's devices can watch it, not only the
 * one that knows the code.
 */

import * as Y from "yjs"

import { deriveKey, toBase64Url, utf8, type Bytes } from "@/lib/crypto"
import {
  isInvitationExpired,
  putDeviceRecord,
  putRedemption,
  verifyRedemption,
  type Invitation,
} from "@/lib/directory"
import type { DeviceIdentity } from "@/lib/identity"
import type { Transport } from "@/lib/sync"

import {
  grantedInvitationIds,
  invitationsInDoc,
  redeemIntoNotebook,
  redemptionsInDoc,
  withdrawnInvitations,
} from "./admission"
import { adminDids, readNotebookWorkspace } from "./notebook-workspace"
import { anyone, createDirectoryReplica, type DirectoryChannel } from "./replicas"
import { openSyncSession, type RelayWatch } from "./sync-session"

export async function joinChannel(invitationId: string): Promise<DirectoryChannel> {
  const secret = utf8(`synk/join/${invitationId}`)
  const id = await deriveKey(secret, "synk/join-resource/v1", 16)
  const dek: Bytes = await deriveKey(secret, "synk/join-key/v1")
  return {
    resourceId: `join:${toBase64Url(id)}`,
    keys: {
      current: () => Promise.resolve({ epoch: 0, dek }),
      forEpoch: (epoch) => Promise.resolve(epoch === 0 ? dek : undefined),
    },
  }
}

/** Requests in `request` that prove the code, put into the directory. Returns how many were new. */
export async function copyJoinRequests(options: {
  directory: Y.Doc
  request: Y.Doc
  invitation: Invitation
  now?: number
}): Promise<number> {
  const held = new Set(redemptionsInDoc(options.directory, options.invitation.invitationId).map((each) => each.sig))
  let copied = 0
  for (const redemption of redemptionsInDoc(options.request, options.invitation.invitationId)) {
    if (held.has(redemption.sig)) continue
    if (!(await verifyRedemption(redemption, options.invitation, options.now === undefined ? {} : { now: options.now }))) {
      continue
    }
    options.directory.transact(() => {
      putDeviceRecord(options.directory, redemption.record)
      putRedemption(options.directory, redemption)
    })
    held.add(redemption.sig)
    copied += 1
  }
  return copied
}

/** Invitations still waiting on someone: issued, not withdrawn, not granted, not lapsed. */
export async function outstandingInvitations(directory: Y.Doc, owner: string, now = Date.now()): Promise<Invitation[]> {
  const withdrawn = await withdrawnInvitations(directory, owner)
  const granted = grantedInvitationIds(directory)
  return invitationsInDoc(directory).filter(
    (invitation) =>
      !withdrawn.has(invitation.invitationId) &&
      !granted.has(invitation.invitationId) &&
      !isInvitationExpired(invitation, now),
  )
}

export interface JoinChannelAccess {
  transportFor(resourceId: string): Transport
  relay: RelayWatch
}

/**
 * The invitee's side: the request, left on the invitation's channel. Resolves
 * once the relay holds it, so closing the page after does not lose it.
 */
export async function requestToJoin(options: {
  secret: Bytes
  invitation: Invitation
  device: DeviceIdentity
  access: JoinChannelAccess
  now?: number
  waitMs?: number
}): Promise<void> {
  const channel = await joinChannel(options.invitation.invitationId)
  const transport = options.access.transportFor(channel.resourceId)
  const doc = new Y.Doc()
  await redeemIntoNotebook({ doc, secret: options.secret, device: options.device, ...(options.now === undefined ? {} : { now: options.now }) })
  const engine = createDirectoryReplica({ doc, channel, device: options.device, transport, policy: anyone })
  const session = openSyncSession({
    engine,
    doc,
    transport,
    resourceId: channel.resourceId,
    readableEpochs: () => [],
    relay: options.access.relay,
    canAuthor: true,
    recover: "publish-state",
  })
  try {
    // Published by the session's catch-up, once the relay is reachable.
    const until = Date.now() + (options.waitMs ?? 20_000)
    for (;;) {
      await session.settled()
      if (await engine.delivered()) return
      if (Date.now() > until) throw new Error("the request has not reached the relay yet")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    session.close()
    engine.close()
  }
}

/**
 * The owner's side: watch the channel of every outstanding invitation while
 * this device is one of the owner's, and copy what arrives. Returns a stop.
 */
export function watchJoinRequests(options: {
  notebookId: string
  directory: Y.Doc
  device: DeviceIdentity
  access: JoinChannelAccess
  onError?: (error: unknown) => void
}): () => void {
  const open = new Map<string, () => void>()
  let stopped = false
  let running: Promise<void> = Promise.resolve()

  const watch = async (invitation: Invitation): Promise<() => void> => {
    const channel = await joinChannel(invitation.invitationId)
    const transport = options.access.transportFor(channel.resourceId)
    const request = new Y.Doc()
    const engine = createDirectoryReplica({ doc: request, channel, device: options.device, transport, policy: anyone })
    const copy = () => {
      void copyJoinRequests({ directory: options.directory, request, invitation }).catch(options.onError)
    }
    request.on("update", copy)
    const session = openSyncSession({
      engine,
      doc: request,
      transport,
      resourceId: channel.resourceId,
      readableEpochs: () => [],
      relay: options.access.relay,
      // Only reads: nothing of the owner's belongs on someone else's channel.
      canAuthor: false,
      recover: "publish-state",
    })
    return () => {
      request.off("update", copy)
      session.close()
      engine.close()
    }
  }

  const refresh = async () => {
    if (stopped) return
    const workspace = await readNotebookWorkspace({
      doc: options.directory,
      notebookId: options.notebookId,
      selfDid: options.device.did,
    })
    const owner = workspace.ownership.owner
    const wanted =
      owner && adminDids(workspace).includes(options.device.did)
        ? await outstandingInvitations(options.directory, owner)
        : []
    const ids = new Set(wanted.map((invitation) => invitation.invitationId))
    for (const [id, stop] of open) {
      if (ids.has(id)) continue
      stop()
      open.delete(id)
    }
    for (const invitation of wanted) {
      if (stopped || open.has(invitation.invitationId)) continue
      open.set(invitation.invitationId, await watch(invitation))
    }
  }

  // Serialised, so two quick changes never open one channel twice.
  const schedule = () => {
    running = running.then(refresh).catch((error: unknown) => options.onError?.(error))
  }
  options.directory.on("update", schedule)
  schedule()

  return () => {
    stopped = true
    options.directory.off("update", schedule)
    for (const stop of open.values()) stop()
    open.clear()
  }
}
