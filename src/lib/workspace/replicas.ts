/**
 * The notebook's two shared documents, synced through the relay.
 *
 * The directory has to be reachable by someone who holds no key yet - an
 * invitee writes their redemption into it - and it holds the very keys
 * everything else is sealed under, so it cannot itself be sealed under them.
 * Every record in it is signed and re-verified on read, so who wrote an
 * update proves nothing and nothing here checks it. It is sealed under a key
 * derived from the notebook id: readable by whoever holds the link, which is
 * who could join its WebRTC room before, and not by the relay.
 *
 * The tree is content - titles and folders - and is sealed under the epoch
 * keys and written only by members with write capability, as a note is.
 *
 * Both are small and written from any tab, so neither pins a client id or
 * keeps a per-device cursor. Each session writes in its own lane and recovers
 * by publishing its whole state.
 */

import type * as Y from "yjs"

import { CapabilityWritePolicy } from "@/lib/authz"
import { deriveKey, toBase64Url, utf8, type Bytes, type SigningKey } from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import {
  DirectoryAuthorResolver,
  lanedAuthors,
  lanedPolicy,
  newLane,
  SyncEngine,
  type AuthorResolver,
  type EpochKeyProvider,
  type Transport,
  type WritePolicy,
} from "@/lib/sync"

import { authorizationContext } from "./capabilities"
import { notebookKeyProvider } from "./note-sync"
import { resourceIdFor, workspaceIdFor } from "./notebook-workspace"

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

const anyone: WritePolicy = { canWrite: () => true }

export interface DirectoryReplicaOptions {
  doc: Y.Doc
  channel: DirectoryChannel
  device: ReplicaDevice
  transport: Transport
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
    policy: anyone,
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
      ),
    ),
    keys: notebookKeyProvider(options.keys),
    attributeOperations: false,
    ...(options.batchMs === undefined ? {} : { batchMs: options.batchMs }),
    ...(options.onError ? { onError: options.onError } : {}),
  })
}
