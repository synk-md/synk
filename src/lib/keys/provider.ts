/**
 * Adapts a `ReadKeySource` to the `EpochKeyProvider` the sync engine takes.
 *
 * The envelope layer only ever asks two things - the key to seal with now, and
 * the key for an epoch it received - so the whole keyring mechanism stays
 * behind this seam.
 */

import type { Bytes } from "@/lib/crypto"
import type { EpochKeyProvider } from "@/lib/sync"
import type { ReadKeySource } from "./domain"

export class KeyringEpochProvider implements EpochKeyProvider {
  private readonly source: ReadKeySource

  constructor(source: ReadKeySource) {
    this.source = source
  }

  async current(): Promise<{ epoch: number; dek: Bytes }> {
    const epoch = this.source.currentEpoch
    const dek = await this.source.keyFor(epoch)
    if (!dek) {
      // A member who cannot open the current epoch has been removed, or has not
      // yet received their copy. Either way they must not author under a stale
      // key - that would produce envelopes nobody can read.
      throw new Error(
        `no readable key for the current epoch ${epoch} of ${this.source.domain}`,
      )
    }
    return { epoch, dek }
  }

  /** Undefined is the honest answer for an epoch outside this member's reach. */
  forEpoch(epoch: number): Promise<Bytes | undefined> {
    return this.source.keyFor(epoch)
  }
}
