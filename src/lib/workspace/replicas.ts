/**
 * The notebook's two shared documents, synced through the relay.
 *
 * The directory has to be readable by someone who holds no key yet - an
 * invitee checks their invitation in it - and it holds the very keys
 * everything else is sealed under, so it cannot itself be sealed under them.
 * It is sealed under a key derived from the notebook id: readable by whoever
 * holds the link, which is who could join its WebRTC room before, and not by
 * the relay. Every record in it is signed and re-verified on read, but a
 * record can still be overwritten or deleted, so only the owner and current
 * members' writes are taken. An invitee asks on a channel of their own.
 *
 * The tree is content - titles and folders - and is sealed under the epoch
 * keys and written only by members with write capability, as a note is.
 *
 * Both are small and written from any tab, so neither pins a client id or
 * keeps a per-device cursor. Each session writes in its own lane and recovers
 * by publishing its whole state.
 */

import * as Y from "yjs"

import { CapabilityWritePolicy } from "@/lib/authz"
import { deriveKey, toBase64Url, utf8, type Bytes, type SigningKey } from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import {
  DirectoryAuthorResolver,
  laneOwner,
  lanedAuthors,
  lanedPolicy,
  newLane,
  SyncEngine,
  type AuthorResolver,
  type EpochKeyProvider,
  type Transport,
  type WritePolicy,
} from "@/lib/sync"

import { authorizationContext, linkedPrincipal } from "./capabilities"
import { notebookKeyProvider } from "./note-sync"
import { readNotebookWorkspace, resourceIdFor, workspaceIdFor } from "./notebook-workspace"
import { pinnedOwner } from "./owner-pins"

export interface ReplicaDevice {
  did: string
  signingKey: SigningKey
}

export interface DirectoryChannel {
  /** Opaque to the relay: it cannot be traced back to the notebook. */
  resourceId: string
  keys: EpochKeyProvider
}

/** Where a notebook's directory lives on the relay, and the key it is sealed under. */
export async function directoryChannel(notebookId: string): Promise<DirectoryChannel> {
  const secret = utf8(`synk/notebook/${notebookId}`)
  const id = await deriveKey(secret, "synk/directory-resource/v1", 16)
  const dek: Bytes = await deriveKey(secret, "synk/directory-key/v1")
  return {
    resourceId: `directory:${toBase64Url(id)}`,
    keys: {
      current: () => Promise.resolve({ epoch: 0, dek }),
      forEpoch: (epoch) => Promise.resolve(epoch === 0 ? dek : undefined),
    },
  }
}

/** A did:key names its own public key. Writing proves only that, which is all it needs to. */
const selfCertifying: AuthorResolver = {
  resolve(did) {
    try {
      return Promise.resolve({ publicKey: publicKeyFromDid(did, "ed25519"), clientId: 0 })
    } catch {
      return Promise.resolve(undefined)
    }
  },
}

/** For channels whose records prove themselves: a pairing, a join request. */
export const anyone: WritePolicy = { canWrite: () => true }

/**
 * The owner and current members' devices, judged from the directory as it
 * stands. Until an owner is known - established, or remembered - there is
 * nothing to protect yet. A member's write that arrives
 * before their admission is refused, not lost: it is fetched again next time.
 */
export function directoryWriters(doc: Y.Doc, notebookId: string): WritePolicy {
  return {
    /**
     * Someone this directory does not know yet may be taking over: a recovery
     * names a device nobody has met. Their update is tried on a copy, and
     * taken only if, with it, they are the owner.
     */
    async canWriteWith(_resourceId, author, update) {
      const scratch = new Y.Doc()
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
      Y.applyUpdate(scratch, update)
      const workspace = await readNotebookWorkspace({ doc: scratch, notebookId })
      return workspace.ownership.owner === laneOwner(author)
    },
    async canWrite(_resourceId, author) {
      const workspace = await readNotebookWorkspace({ doc, notebookId })
      // Remembered before the directory itself has arrived - a new device, or
      // one joining - so even the first writes are judged.
      const owner = workspace.ownership.owner ?? pinnedOwner(notebookId)
      if (!owner) return true
      const device = laneOwner(author)
      return device === owner || (workspace.directory?.devices.some((entry) => entry.record.did === device) ?? false)
    },
  }
}

export interface DirectoryReplicaOptions {
  doc: Y.Doc
  channel: DirectoryChannel
  device: ReplicaDevice
  transport: Transport
  /** Whose writes count. Anyone's unless said: a notebook's directory says `directoryWriters`. */
  policy?: WritePolicy
  batchMs?: number
  onError?: (error: unknown) => void
}

export function createDirectoryReplica(options: DirectoryReplicaOptions): SyncEngine {
  return new SyncEngine({
    doc: options.doc,
    resourceId: options.channel.resourceId,
    author: newLane(options.device.did),
    signingKey: options.device.signingKey,
    clientId: options.doc.clientID,
    transport: options.transport,
    authors: lanedAuthors(selfCertifying),
    policy: options.policy ?? anyone,
    keys: options.channel.keys,
    attributeOperations: false,
    ...(options.batchMs === undefined ? {} : { batchMs: options.batchMs }),
    ...(options.onError ? { onError: options.onError } : {}),
  })
}

/** Beneath the notebook, so a notebook grant covers it. */
export function treeResourceId(notebookId: string): string {
  return `${resourceIdFor(notebookId)}/tree`
}

export interface TreeReplicaOptions {
  tree: Y.Doc
  /** The verified directory: who may write, and with which key. */
  directory: Y.Doc
  notebookId: string
  owner: string
  device: ReplicaDevice
  keys: ReadKeySource
  transport: Transport
  now?: () => number
  batchMs?: number
  onError?: (error: unknown) => void
  onDenied?: (author: string, reason: string) => void
}

export function createTreeReplica(options: TreeReplicaOptions): SyncEngine {
  const now = options.now ?? (() => Date.now())
  return new SyncEngine({
    doc: options.tree,
    resourceId: treeResourceId(options.notebookId),
    author: newLane(options.device.did),
    signingKey: options.device.signingKey,
    clientId: options.tree.clientID,
    transport: options.transport,
    authors: lanedAuthors(
      new DirectoryAuthorResolver({
        directory: options.directory,
        trustedAdminDids: [options.owner],
        workspace: workspaceIdFor(options.notebookId),
      }),
    ),
    policy: lanedPolicy(
      new CapabilityWritePolicy(
        async () => authorizationContext(options.directory, options.owner, now()),
        (author, result) => {
          options.onDenied?.(author, result.reason ?? "unauthorized")
        },
        linkedPrincipal(options.directory, options.owner, workspaceIdFor(options.notebookId)),
      ),
    ),
    keys: notebookKeyProvider(options.keys),
    attributeOperations: false,
    ...(options.batchMs === undefined ? {} : { batchMs: options.batchMs }),
    ...(options.onError ? { onError: options.onError } : {}),
  })
}
