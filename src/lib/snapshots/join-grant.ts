/**
 * An epoch cut and the snapshot that makes it usable, produced as one unit.
 *
 * A sealed key alone admits nobody to a non-empty notebook - the joiner can
 * decrypt what comes next and place none of it, because every pre-existing
 * author has a gap. `stageAddMember` computes the cut without applying it, so a
 * grant without a usable snapshot behind it is never created.
 *
 * Produced by the admitting admin from its own replica, and deposited in the
 * relay archive, so no other member need ever come online.
 *
 * Staleness heals by replay in one direction only: envelopes written after the
 * cut are under an epoch the joiner holds, but one written under a *pre-join*
 * epoch the admin had not seen is in neither the snapshot nor their reach.
 * `relayVector` makes being caught up a precondition rather than a hope.
 */

import type { SigningKey } from "@/lib/crypto"
import type { KeyDomainAdmin, KeyRecipient, SealedEpochKey } from "@/lib/keys"
import type { EpochRecord } from "@/lib/keys"
import type { DeliveryVector, Transport } from "@/lib/sync"
import * as Y from "yjs"
import { createJoinSnapshot, needsJoinSnapshot } from "./join"
import type { Snapshot } from "./snapshot"

export interface JoinGrant {
  /** The epoch cut for this join. */
  record: EpochRecord
  /** The joiner's sealed copy of the new epoch key. */
  sealed: SealedEpochKey[]
  /** Null only for an empty notebook, where there are no gaps to close. */
  snapshot: Snapshot | null
}

export interface AdmitMemberOptions {
  /** The domain being joined. Advanced only once everything else succeeded. */
  domain: KeyDomainAdmin
  joiner: KeyRecipient
  /** The admitting admin's replica. Whatever it has is what gets snapshotted. */
  doc: Y.Doc
  /** The admin's own device key - the snapshot is signed by, and attributed to, it. */
  signingKey: SigningKey
  author: string
  resourceId: string
  /** The point in the log the admin's replica has reached. */
  covers: DeliveryVector
  /** Previous snapshot id, to extend the hash-linked chain. */
  parent?: string | null
  /**
   * What the relay holds. When supplied, admission is refused if the admin is
   * behind it - see the staleness note above.
   */
  relayVector?: DeliveryVector
  createdAt?: number
}

export interface StalenessReport {
  stale: boolean
  /** Authors the relay has more of than this replica does. */
  behind: string[]
}

/**
 * Is this replica behind the relay?
 *
 * Only a lag on envelopes the joiner will never be able to read matters, and at
 * cut time every existing envelope is under a pre-join epoch - so any lag at
 * all is disqualifying.
 */
export function admissionStaleness(
  covers: DeliveryVector,
  relayVector: DeliveryVector,
): StalenessReport {
  const behind = Object.entries(relayVector)
    .filter(([author, seq]) => seq > (covers[author] ?? 0))
    .map(([author]) => author)
    .sort()
  return { stale: behind.length > 0, behind }
}

/**
 * Admit a member: cut the epoch, build the snapshot, and only then advance.
 *
 * Throws without advancing if the snapshot cannot be produced, so there is no
 * path that yields a grant the joiner cannot use.
 */
export async function admitMemberWithSnapshot(
  options: AdmitMemberOptions,
): Promise<JoinGrant> {
  if (options.relayVector) {
    const { stale, behind } = admissionStaleness(options.covers, options.relayVector)
    if (stale) {
      throw new Error(
        `refusing to admit from a replica behind the relay on ${behind.join(", ")}: ` +
          `content written under a pre-join epoch that this replica has not seen would be ` +
          `invisible to the joiner and could not be healed by replay. Sync first.`,
      )
    }
  }

  const staged = await options.domain.stageAddMember(options.joiner, {
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  })

  let snapshot: Snapshot | null = null
  if (needsJoinSnapshot(options.doc)) {
    // Sealed under the NEW epoch key - the only one the joiner holds. Built
    // before `commit`, so a failure here leaves no epoch published.
    snapshot = await createJoinSnapshot({
      doc: options.doc,
      signingKey: options.signingKey,
      author: options.author,
      domain: staged.record.domain,
      resourceId: options.resourceId,
      epoch: staged.record.epoch,
      dek: staged.key,
      covers: options.covers,
      parent: options.parent ?? null,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
  }

  staged.commit()
  return { record: staged.record, sealed: staged.sealed, snapshot }
}

/**
 * Publish a grant so a joiner can collect it without anyone being online.
 *
 * The sealed keys and the epoch record travel with the directory (M7's
 * membership work); the snapshot goes to the relay archive. Both are opaque to
 * the relay.
 */
export async function depositJoinGrant(transport: Transport, grant: JoinGrant): Promise<void> {
  if (grant.snapshot) await transport.depositSnapshot(grant.snapshot)
}

export interface CollectJoinMaterialOptions {
  transport: Transport
  resourceId: string
  /** Epochs the joiner can actually open, from its keyring. */
  readableEpochs: readonly number[]
}

/**
 * The joiner's side: find the newest archived snapshot it can actually open.
 *
 * Newest-first because a later baseline means less to replay afterwards, and
 * filtered by readable epoch because the archive holds snapshots for epochs a
 * joiner was never given - trying them would only produce decryption failures.
 */
export async function collectJoinSnapshot(
  options: CollectJoinMaterialOptions,
): Promise<Snapshot | undefined> {
  const readable = new Set(options.readableEpochs)
  const archived = await options.transport.fetchSnapshots(options.resourceId)
  return [...archived]
    .filter((snapshot) => readable.has(snapshot.epoch))
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1)
}
