/**
 * A notebook's content keys: the signed epoch timeline and the sealed copies,
 * carried in its index document.
 *
 * Only two things persist, and neither is a secret. The timeline is signed
 * structure - which epoch was a chain step and which a rotation - and the
 * keyring is one sealed box per member per epoch, openable by that member
 * alone. Live key material is never written anywhere: the writer's view is
 * reconstructed on demand by whoever can open their own copies.
 *
 * `verifyTimeline` is the only route from stored records to a usable timeline,
 * so a peer that writes a plausible-looking record cannot get it into the
 * derivation path.
 */

import * as Y from "yjs"

import type { AuthorizationContext } from "@/lib/authz"
import type { Bytes } from "@/lib/crypto"
import { slotFor } from "@/lib/directory"
import {
  deriveChainedEpochKey,
  epochKeyCommitment,
  FlatKeyring,
  KeyDomainAdmin,
  openEpochKey,
  type EpochTimeline,
  type SealedEpochKey,
} from "@/lib/keys"
import type { DeviceIdentity } from "@/lib/identity"
import {
  signEpochRecord,
  verifyTimeline,
  type SignedEpochRecord,
  type TimelineVerification,
} from "@/lib/membership"

import { authorizationContext, issueOwnerRoot, ownerHoldsRoot, putCapability } from "./capabilities"
import { resourceIdFor } from "./notebook-workspace"
import { rememberedEpoch, rememberEpoch } from "./remembered-epochs"

export const EPOCH_MAP = "workspace:epochs"
export const KEYRING_MAP = "workspace:keyring"

/** The key domain a notebook's content is sealed under. */
export function keyDomainFor(notebookId: string): string {
  return `notebook:${notebookId}`
}

function epochMap(doc: Y.Doc): Y.Map<SignedEpochRecord> {
  return doc.getMap<SignedEpochRecord>(EPOCH_MAP)
}

function keyringMap(doc: Y.Doc): Y.Map<SealedEpochKey> {
  return doc.getMap<SealedEpochKey>(KEYRING_MAP)
}

/** Distinct per domain, epoch and recipient, so copies never collide. */
/**
 * One slot per copy, not per recipient. With one slot a copy planted for
 * someone's device replaced the genuine one; now both are kept and the reader
 * picks by commitment.
 */
export function sealedKeyId(sealed: SealedEpochKey): string {
  // The whole box, so the only copy that can take a slot is the one already in it.
  return `${sealed.domain}|${String(sealed.epoch)}|${sealed.recipient}|${sealed.box}`
}

/** Where a copy was filed before copies had a slot each. Still read. */
function legacySealedKeyId(sealed: SealedEpochKey): string {
  return `${sealed.domain}|${String(sealed.epoch)}|${sealed.recipient}`
}

/**
 * In a slot of its own. Two admins cutting the same epoch each keep theirs, and
 * the timeline picks one the same way everywhere; nobody can replace a record.
 */
export function putEpochRecord(doc: Y.Doc, signed: SignedEpochRecord): void {
  epochMap(doc).set(slotFor(String(signed.record.epoch), signed.sig), signed)
}

export function putSealedKeys(doc: Y.Doc, sealed: readonly SealedEpochKey[]): void {
  const map = keyringMap(doc)
  for (const copy of sealed) map.set(sealedKeyId(copy), copy)
}

export function storedEpochRecords(doc: Y.Doc, domain: string): SignedEpochRecord[] {
  const out = new Map<string, SignedEpochRecord>()
  for (const signed of epochMap(doc).values()) {
    if (signed?.record?.domain !== domain || typeof signed.sig !== "string") continue
    out.set(signed.sig, signed)
  }
  return [...out.values()].sort((a, b) => a.record.epoch - b.record.epoch)
}

export function storedSealedKeys(doc: Y.Doc, domain: string): SealedEpochKey[] {
  const out: SealedEpochKey[] = []
  for (const [key, sealed] of keyringMap(doc).entries()) {
    if (sealed?.domain !== domain || typeof sealed.box !== "string") continue
    if (sealedKeyId(sealed) !== key && legacySealedKeyId(sealed) !== key) continue
    out.push(sealed)
  }
  return out
}

export interface FoundKeysOptions {
  doc: Y.Doc
  notebookId: string
  device: DeviceIdentity
  createdAt?: number
}

export interface FoundedKeys {
  domain: string
  timeline: EpochTimeline
  sealed: SealedEpochKey[]
}

/**
 * Start a notebook's key domain.
 *
 * Issues the owner's root capability first, because signing the genesis epoch
 * record is itself an admin-gated act: without the root, the record this call
 * writes would fail its own verification on the next read.
 *
 * Idempotent, like founding the workspace - a notebook that already has a
 * genesis epoch is left alone rather than given a second, conflicting one.
 */
export async function foundNotebookKeys(options: FoundKeysOptions): Promise<FoundedKeys> {
  const domain = keyDomainFor(options.notebookId)
  const resource = resourceIdFor(options.notebookId)
  const now = options.createdAt ?? Date.now()

  const existing = storedEpochRecords(options.doc, domain)
  if (existing.length > 0) {
    return {
      domain,
      timeline: existing.map((signed) => signed.record),
      sealed: storedSealedKeys(options.doc, domain),
    }
  }

  if (!(await ownerHoldsRoot(options.doc, options.device.did, resource, now))) {
    putCapability(
      options.doc,
      await issueOwnerRoot({
        signingKey: options.device.signingKey,
        owner: options.device.did,
        resource,
        now,
      }),
    )
  }

  const { admin, sealed } = await KeyDomainAdmin.create(
    domain,
    [{ sealingDid: options.device.record.sealingDid }],
    { createdAt: now },
  )
  const signed = await signEpochRecord(
    admin.timeline[0],
    options.device.signingKey,
    options.device.did,
  )

  // One transaction: a peer must never see a sealed key whose epoch record is
  // not there to verify it against.
  options.doc.transact(() => {
    putEpochRecord(options.doc, signed)
    putSealedKeys(options.doc, sealed)
  })

  return { domain, timeline: admin.timeline, sealed: [...sealed] }
}

/**
 * The key a candidate copy yields for the first committed epoch it can reach
 * by derivation, judged against that commitment. `undefined` when nothing
 * ahead of it in its segment is committed - an epoch from before commitments.
 */
async function judge(timeline: EpochTimeline, epoch: number, key: Bytes): Promise<boolean | undefined> {
  let current = key
  for (let at = epoch; at <= timeline.length; at += 1) {
    const record = timeline[at - 1]
    if (at > epoch) {
      // A rotation starts a new key; nothing past it says anything about this one.
      if (record.kind !== "chain") return undefined
      current = await deriveChainedEpochKey(current)
    }
    if (record.commitment !== undefined) return (await epochKeyCommitment(current)) === record.commitment
  }
  return undefined
}

/**
 * This device's anchor keys, each the copy its epoch's commitment vouches for.
 *
 * Copies are unsigned and anyone holding the link can file one, so several
 * may claim the same epoch. A copy contradicted by a commitment is dropped;
 * among copies nothing can judge - epochs from before commitments - the first
 * is used, as before.
 */
async function openVerifiedAnchors(
  timeline: EpochTimeline,
  sealed: readonly SealedEpochKey[],
  device: DeviceIdentity,
): Promise<{ anchors: Map<number, Bytes>; rejected: number }> {
  const domain = timeline[0].domain
  const candidates = new Map<number, Bytes[]>()
  for (const copy of sealed) {
    if (copy.domain !== domain || copy.recipient !== device.record.sealingDid) continue
    if (!timeline[copy.epoch - 1]) continue
    try {
      const key = await openEpochKey(copy, device.sealingKey)
      candidates.set(copy.epoch, [...(candidates.get(copy.epoch) ?? []), key])
    } catch {
      // Not openable by this device: somebody else's, or garbage.
    }
  }

  const anchors = new Map<number, Bytes>()
  let rejected = 0
  for (const [epoch, keys] of candidates) {
    let fallback: Bytes | undefined
    let chosen: Bytes | undefined
    for (const key of keys) {
      const verdict = await judge(timeline, epoch, key)
      if (verdict === true) {
        chosen = key
        break
      }
      if (verdict === undefined) fallback ??= key
      else rejected += 1
    }
    const anchor = chosen ?? fallback
    if (anchor) anchors.set(epoch, anchor)
  }
  return { anchors, rejected }
}

/**
 * Give a notebook whose current epoch predates commitments a committed one.
 *
 * Only the owner can, since only an admin signs epochs. A chain step, so every
 * member derives the new key from what they hold - and one holding a planted
 * key derives a key that fails the commitment rather than one an attacker
 * knows. Returns whether a step was taken.
 */
export async function commitCurrentKey(options: {
  doc: Y.Doc
  notebookId: string
  owner: DeviceIdentity
}): Promise<boolean> {
  const keys = await readNotebookKeys({
    doc: options.doc,
    notebookId: options.notebookId,
    device: options.owner,
    owner: options.owner.did,
  })
  const latest = keys.timeline?.[keys.timeline.length - 1]
  if (keys.access !== "reader" || !latest || latest.commitment !== undefined) return false
  const domain = await restoreDomainAdmin(keys)
  if (!domain) return false
  const staged = await domain.stageCommitment()
  putEpochRecord(options.doc, await signEpochRecord(staged.record, options.owner.signingKey, options.owner.did))
  staged.commit()
  return true
}

export type KeyAccess =
  /** This device holds keys and can read content. */
  | "reader"
  /** Nothing is sealed to this device, so content is unreadable here. */
  | "no-keys"
  /** The stored timeline did not verify. Nothing is derived from it. */
  | "untrusted-timeline"
  /**
   * Keys were sealed to this device, but none matches what the owner committed
   * to. Someone planted them. Nothing is sealed under them, so nothing written
   * here goes where the planter can read it.
   */
  | "untrusted-keys"
  /** The notebook has no key domain yet. */
  | "none"

export interface NotebookKeys {
  domain: string
  access: KeyAccess
  /** The reader view, when there is one. */
  keyring: FlatKeyring | null
  timeline: EpochTimeline | null
  /** Why the timeline was refused, when it was. */
  verification: TimelineVerification | null
  /** Epochs this device can open. Exactly what it can decrypt. */
  readableEpochs: number[]
  /**
   * Whether that includes the current one. A removed device keeps the epochs
   * it held, so it still reads as a reader - and can open nothing written
   * since, nor seal anything anyone else will accept.
   */
  current: boolean
}

export interface ReadKeysOptions {
  doc: Y.Doc
  notebookId: string
  device: DeviceIdentity
  /** Resolved from the workspace genesis. Without it nothing can be trusted. */
  owner: string | null
  now?: number
  /** Supplied when the caller already built one, to avoid a second walk. */
  context?: AuthorizationContext
}

/**
 * Rebuild this device's reader view.
 *
 * A refused timeline yields no keyring at all rather than a partial one:
 * deriving against a structure that may be wrong about which epochs chain is
 * precisely the confusion signing prevents.
 */
export async function readNotebookKeys(options: ReadKeysOptions): Promise<NotebookKeys> {
  const domain = keyDomainFor(options.notebookId)
  const now = options.now ?? Date.now()

  const empty: NotebookKeys = {
    domain,
    access: "none",
    keyring: null,
    timeline: null,
    verification: null,
    readableEpochs: [],
    current: false,
  }
  if (!options.owner) return empty

  const records = storedEpochRecords(options.doc, domain)
  if (records.length === 0) return empty

  const context =
    options.context ?? (await authorizationContext(options.doc, options.owner, now))
  const verification = await verifyTimeline(records, context)
  // `ok` and a present timeline are separate fields, so both are checked rather
  // than one being taken to imply the other.
  const timeline = verification.ok ? verification.timeline : undefined
  if (!timeline) {
    return { ...empty, access: "untrusted-timeline", verification }
  }
  // Ending before an epoch this device already verified means the newest
  // record went missing. Going back would mean writing under an old key.
  const newest = timeline[timeline.length - 1].epoch
  const seen = rememberedEpoch(options.notebookId)
  if (seen !== null && newest < seen) {
    return {
      ...empty,
      access: "untrusted-timeline",
      verification: { ok: false, reason: "behind", failedAt: newest + 1 },
    }
  }
  rememberEpoch(options.notebookId, newest)

  const sealed = storedSealedKeys(options.doc, domain)
  const { anchors, rejected } = await openVerifiedAnchors(timeline, sealed, options.device)
  if (anchors.size === 0) {
    return { ...empty, access: rejected > 0 ? "untrusted-keys" : "no-keys", timeline, verification }
  }

  const keyring = new FlatKeyring(timeline, anchors)
  // Belt and braces: the anchors were chosen by commitment, so this holds
  // unless the choice itself is wrong - and sealing under a key that fails
  // it is the one outcome that must not happen.
  const currentKey = await keyring.keyFor(keyring.currentEpoch)
  const committed = timeline[timeline.length - 1]?.commitment
  if (currentKey && committed !== undefined && (await epochKeyCommitment(currentKey)) !== committed) {
    return { ...empty, access: "untrusted-keys", timeline, verification }
  }
  return {
    domain,
    access: "reader",
    keyring,
    timeline,
    verification,
    readableEpochs: keyring.readableEpochs(),
    current: (await keyring.keyFor(keyring.currentEpoch)) !== undefined,
  }
}

/**
 * The writer's view, for an admin who needs to cut an epoch.
 *
 * Reconstructed from the verified timeline plus the keys this device can open,
 * which is why nothing secret has to be stored: possession of a sealing key is
 * what makes it possible, not a saved blob.
 */
export async function restoreDomainAdmin(keys: NotebookKeys): Promise<KeyDomainAdmin | null> {
  if (keys.access !== "reader" || !keys.keyring || !keys.timeline) return null

  const held = new Map<number, Uint8Array>()
  for (const epoch of keys.keyring.anchorEpochs) {
    const key = await keys.keyring.keyFor(epoch)
    if (key) held.set(epoch, key)
  }
  return KeyDomainAdmin.restore(keys.timeline, held)
}
