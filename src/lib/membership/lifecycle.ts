/**
 * Membership lifecycle: add, change level, remove.
 *
 * Each operation is a composition of pieces built earlier, and the composition
 * is the point - doing them in the wrong order, or omitting one, is how a
 * membership system quietly fails:
 *
 *   add           cut a chain epoch, seal the new key to the joiner only,
 *                 produce the joiner snapshot under that key, issue a
 *                 capability - all atomically (M5 + M6 + M7)
 *   change level  revoke the old capability, issue the new one
 *   remove        revoke every capability, rotate to a fresh epoch, reseal to
 *                 whoever remains
 *
 * Removal is `revoke + rotate + reseal`, and both halves are load-bearing.
 * Revocation stops accepted writes as soon as it propagates; rotation denies
 * future reads regardless of whether it propagates at all. Neither alone is
 * enough: revocation is eventually consistent, and rotation cannot un-share
 * what the member already decrypted.
 */

import type { SigningKey } from "@/lib/crypto"
import {
  issueCapability,
  revokeCapability,
  type Ability,
  type Capability,
  type Revocation,
} from "@/lib/authz"
import type { KeyDomainAdmin, KeyRecipient, SealedEpochKey } from "@/lib/keys"
import type { EpochRecord } from "@/lib/keys"
import { admitMemberWithSnapshot, type JoinGrant } from "@/lib/snapshots"
import type { Snapshot } from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"
import type * as Y from "yjs"
import { signEpochRecord, type SignedEpochRecord } from "./epoch-timeline"
import { assertKeyringCurrent } from "./seal-guard"
import type { ReadKeySource } from "@/lib/keys"

/** An admin acting on a workspace: their device key and identity. */
export interface ActingAdmin {
  signingKey: SigningKey
  did: string
}

export interface AddMemberOptions {
  admin: ActingAdmin
  domain: KeyDomainAdmin
  resource: string
  /** The joining device's signing identity - the capability's audience. */
  joinerDid: string
  /** Where their epoch key is sealed. */
  joinerSealingDid: string
  ability: Ability
  /** The admin's replica, snapshotted for the joiner. */
  doc: Y.Doc
  covers: DeliveryVector
  /** The admin's keyring view, proven current before anything is sealed. */
  keyring: Pick<ReadKeySource, "domain" | "currentEpoch">
  /** Refuse if the admin is behind the relay - see M6's staleness note. */
  relayVector?: DeliveryVector
  parentSnapshot?: string | null
  expiresAt: number
  now?: number
}

export interface AddMemberResult {
  grant: JoinGrant
  capability: Capability
  epochRecord: SignedEpochRecord
  snapshot: Snapshot | null
}

/**
 * Add a member.
 *
 * The keyring currency check comes first, before anything is cut: sealing from
 * a stale view would hand the joiner a key for a superseded epoch and strand
 * them, and discovering that afterwards means unpicking a published grant.
 */
export async function addMember(options: AddMemberOptions): Promise<AddMemberResult> {
  const now = options.now ?? Date.now()
  assertKeyringCurrent(options.keyring, options.domain.timeline)

  const grant = await admitMemberWithSnapshot({
    domain: options.domain,
    joiner: { sealingDid: options.joinerSealingDid },
    doc: options.doc,
    signingKey: options.admin.signingKey,
    author: options.admin.did,
    resourceId: options.resource,
    covers: options.covers,
    parent: options.parentSnapshot ?? null,
    ...(options.relayVector ? { relayVector: options.relayVector } : {}),
    createdAt: now,
  })

  const capability = await issueCapability({
    signingKey: options.admin.signingKey,
    issuer: options.admin.did,
    audience: options.joinerDid,
    resource: options.resource,
    ability: options.ability,
    notBefore: now,
    expiresAt: options.expiresAt,
  })

  return {
    grant,
    capability,
    epochRecord: await signEpochRecord(grant.record, options.admin.signingKey, options.admin.did),
    snapshot: grant.snapshot,
  }
}

export interface ChangeLevelOptions {
  admin: ActingAdmin
  resource: string
  memberDid: string
  /** Every capability currently held by this member for this resource. */
  held: readonly Capability[]
  ability: Ability
  expiresAt: number
  now?: number
  reason?: string
}

export interface ChangeLevelResult {
  revocations: Revocation[]
  capability: Capability
}

/**
 * Change a member's level.
 *
 * Revoke then issue, not the reverse: a window where both the old and new grant
 * are live is a window where the member briefly holds the union of them, which
 * for a downgrade is exactly what the change was meant to prevent.
 *
 * No rotation is ever needed here, which is worth stating because it looks like
 * it should be. Every ability implies read, so a level change - in any
 * direction - leaves the member able to decrypt. Withdrawing read is not a
 * level change at all; it is `removeMember`, which rotates.
 */
export async function changeMemberLevel(
  options: ChangeLevelOptions,
): Promise<ChangeLevelResult> {
  const now = options.now ?? Date.now()

  const revocations: Revocation[] = []
  for (const capability of options.held) {
    if (capability.payload.aud !== options.memberDid) continue
    revocations.push(
      await revokeCapability({
        signingKey: options.admin.signingKey,
        issuer: options.admin.did,
        capabilityCid: capability.cid,
        revokedAt: now,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    )
  }

  const capability = await issueCapability({
    signingKey: options.admin.signingKey,
    issuer: options.admin.did,
    audience: options.memberDid,
    resource: options.resource,
    ability: options.ability,
    notBefore: now,
    expiresAt: options.expiresAt,
  })

  return { revocations, capability }
}

export interface RemoveMemberOptions {
  admin: ActingAdmin
  domain: KeyDomainAdmin
  resource: string
  memberDid: string
  /** Every capability held by the member being removed. */
  held: readonly Capability[]
  /** Everyone who remains, and where to reseal to them. */
  remaining: readonly KeyRecipient[]
  keyring: Pick<ReadKeySource, "domain" | "currentEpoch">
  now?: number
  reason?: string
}

export interface RemoveMemberResult {
  revocations: Revocation[]
  epochRecord: SignedEpochRecord
  record: EpochRecord
  sealed: SealedEpochKey[]
}

/**
 * Remove a member: revoke, rotate, reseal.
 *
 * The rotation is what makes this real. Revocation is eventually consistent, so
 * a peer that has not seen it keeps accepting the removed member's writes for a
 * while; the fresh epoch denies them reads immediately and permanently, however
 * long they keep the keys they were given.
 */
export async function removeMember(
  options: RemoveMemberOptions,
): Promise<RemoveMemberResult> {
  const now = options.now ?? Date.now()
  assertKeyringCurrent(options.keyring, options.domain.timeline)

  const revocations: Revocation[] = []
  for (const capability of options.held) {
    if (capability.payload.aud !== options.memberDid) continue
    revocations.push(
      await revokeCapability({
        signingKey: options.admin.signingKey,
        issuer: options.admin.did,
        capabilityCid: capability.cid,
        revokedAt: now,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    )
  }

  const cut = await options.domain.removeMember(options.remaining, { createdAt: now })
  return {
    revocations,
    record: cut.record,
    sealed: cut.sealed,
    epochRecord: await signEpochRecord(cut.record, options.admin.signingKey, options.admin.did),
  }
}
