/**
 * Composing the sync engine for one note out of the notebook's own records.
 *
 * Four things the engine needs, and each comes from a layer built earlier:
 *
 *   authors   the verified directory, so an envelope from a device that is not
 *             present by a valid path is rejected before any work is spent
 *   policy    the capability chain, walked to the owner - not "is a member",
 *             which cannot express read-only
 *   keys      this device's epoch keyring, so content is sealed under the
 *             current epoch and opened only where a key is actually held
 *   transport opaque envelopes, and nothing else
 *
 * None of them caches. The directory and the capability set are re-read per
 * check, which is what makes a withdrawn admission or a revoked grant take
 * effect without anything needing to be invalidated.
 */

import type * as Y from "yjs"

import { CapabilityWritePolicy, type AuthorizationContext } from "@/lib/authz"
import type { Bytes, SigningKey } from "@/lib/crypto"
import type { FlatKeyring } from "@/lib/keys"
import {
  DirectoryAuthorResolver,
  SyncEngine,
  type EpochKeyProvider,
  type Transport,
} from "@/lib/sync"

import { authorizationContext } from "./capabilities"
import { resourceIdFor, workspaceIdFor } from "./notebook-workspace"

/** What capabilities call a note. Beneath its notebook, so a notebook grant covers it. */
export function noteResourceId(notebookId: string, noteId: string): string {
  return `${resourceIdFor(notebookId)}/note:${noteId}`
}

/**
 * The keyring as the engine wants it.
 *
 * `current()` throws rather than returning a stale epoch: sealing under an
 * epoch this device can no longer prove is current is how a writer produces
 * content that recent joiners cannot read.
 */
export function notebookKeyProvider(keys: FlatKeyring): EpochKeyProvider {
  return {
    async current(): Promise<{ epoch: number; dek: Bytes }> {
      const epoch = keys.currentEpoch
      const dek = await keys.keyFor(epoch)
      if (!dek) {
        throw new Error(
          `no key held for epoch ${String(epoch)} of ${keys.domain}; refresh before writing`,
        )
      }
      return { epoch, dek }
    },
    forEpoch: (epoch: number) => keys.keyFor(epoch),
  }
}

export interface NoteSyncOptions {
  /** The note being synced. */
  doc: Y.Doc
  notebookId: string
  noteId: string
  /** The notebook's index document, which carries the directory and capabilities. */
  index: Y.Doc
  owner: string
  author: string
  signingKey: SigningKey
  clientId: number
  keys: FlatKeyring
  transport: Transport
  now?: () => number
  onError?: (error: unknown) => void
  onDenied?: (author: string, reason: string) => void
}

/**
 * A sync engine for one note.
 *
 * The write policy resolves its context per check rather than being handed one,
 * because a cached context keeps accepting an author whose capability was
 * revoked - which is the case the check exists for.
 */
export function createNoteSyncEngine(options: NoteSyncOptions): SyncEngine {
  const workspace = workspaceIdFor(options.notebookId)
  const now = options.now ?? (() => Date.now())

  const context = async (): Promise<AuthorizationContext> =>
    authorizationContext(options.index, options.owner, now())

  return new SyncEngine({
    doc: options.doc,
    resourceId: noteResourceId(options.notebookId, options.noteId),
    author: options.author,
    signingKey: options.signingKey,
    clientId: options.clientId,
    transport: options.transport,
    authors: new DirectoryAuthorResolver({
      directory: options.index,
      trustedAdminDids: [options.owner],
      workspace,
    }),
    policy: new CapabilityWritePolicy(context, (did, result) => {
      options.onDenied?.(did, result.reason ?? "unauthorized")
    }),
    keys: notebookKeyProvider(options.keys),
    ...(options.onError ? { onError: options.onError } : {}),
  })
}
