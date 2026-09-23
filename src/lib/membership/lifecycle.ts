/**
 * Add, change level, remove. The composition is the point - doing these in the
 * wrong order, or omitting one, is how a membership system quietly fails.
 *
 * Removal is revoke plus rotate plus reseal, and both halves are load-bearing:
 * revocation stops writes once it propagates, rotation denies reads whether it
 * propagates or not.
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
  /** The capability's audience. */
  joinerDid: string
  /** Where their epoch key is sealed. */
  joinerSealingDid: string
  ability: Ability
  /** The admin's replica, snapshotted for the joiner. */
  doc: Y.Doc
  covers: DeliveryVector
  /** Proven current before anything is sealed. */
  keyring: Pick<ReadKeySource, "domain" | "currentEpoch">
  /** Refuse if the admin is behind the relay. */
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
 * The currency check comes first, before anything is cut: sealing from a stale
 * view strands the joiner, and discovering it afterwards means unpicking a
 * published grant.
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
 * Revoke then issue, not the reverse: both live at once is a window where the
 * member holds the union, which for a downgrade is what it was meant to prevent.
 *
 * No rotation is needed, which is worth stating because it looks like it should
 * be. Withdrawing read is not a level change; it is `removeMember`.
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
 * The rotation is what makes this real: a peer that has not seen the revocation
 * keeps accepting writes for a while, but the fresh epoch denies reads at once.
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
