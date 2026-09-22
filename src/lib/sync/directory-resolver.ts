/**
 * Wires the sync engine to the verified directory (M3).
 *
 * The directory is re-verified on every read, so this deliberately does not
 * cache: an author whose admission was withdrawn, or whose record failed
 * verification, stops resolving without anything needing to be invalidated.
 * When that read cost matters, the fix is a cache with an explicit invalidation
 * signal, not a silently stale one here.
 */

import type * as Y from "yjs"
import { signingPublicKeyOf } from "@/lib/identity"
import { readDirectory, type DirectoryReadOptions } from "@/lib/directory"
import type { AuthorInfo, AuthorResolver, WritePolicy } from "./sync-engine"

export interface DirectoryAuthorityOptions extends DirectoryReadOptions {
  directory: Y.Doc
  trustedAdminDids: readonly string[]
}

/**
 * Resolves an author to its signing key and permitted client id, but only if
 * that device is actually present in the directory by a valid path.
 */
export class DirectoryAuthorResolver implements AuthorResolver {
  private readonly options: DirectoryAuthorityOptions

  constructor(options: DirectoryAuthorityOptions) {
    this.options = options
  }

  async resolve(did: string): Promise<AuthorInfo | undefined> {
    const { directory, trustedAdminDids, ...read } = this.options
    const verified = await readDirectory(directory, trustedAdminDids, read)
    const device = verified.devices.find((entry) => entry.record.did === did)
    if (!device) return undefined
    return {
      publicKey: signingPublicKeyOf(device.record),
      clientId: device.record.clientId,
    }
  }
}

/**
 * Membership as the write rule: a device present in the directory may write.
 *
 * Honestly a placeholder. Real authorisation is a signed delegation chain
 * walked to the resource owner (M6); this is "is a member of the workspace",
 * which is coarser and cannot express read-only.
 */
export class DirectoryMembershipPolicy implements WritePolicy {
  private readonly options: DirectoryAuthorityOptions

  constructor(options: DirectoryAuthorityOptions) {
    this.options = options
  }

  async canWrite(_resourceId: string, authorDid: string): Promise<boolean> {
    const { directory, trustedAdminDids, ...read } = this.options
    const verified = await readDirectory(directory, trustedAdminDids, read)
    return verified.devices.some((entry) => entry.record.did === authorDid)
  }
}
