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
import {
  FlatKeyring,
  KeyDomainAdmin,
  openKeyring,
  readKeysFor,
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
export function sealedKeyId(sealed: SealedEpochKey): string {
  return `${sealed.domain}|${String(sealed.epoch)}|${sealed.recipient}`
}

export function putEpochRecord(doc: Y.Doc, signed: SignedEpochRecord): void {
  epochMap(doc).set(String(signed.record.epoch), signed)
}

export function putSealedKeys(doc: Y.Doc, sealed: readonly SealedEpochKey[]): void {
  const map = keyringMap(doc)
  for (const copy of sealed) map.set(sealedKeyId(copy), copy)
}

export function storedEpochRecords(doc: Y.Doc, domain: string): SignedEpochRecord[] {
  const out: SignedEpochRecord[] = []
  for (const [key, signed] of epochMap(doc).entries()) {
    // Filed under an epoch other than its own, or belonging to another domain.
    if (signed?.record?.domain !== domain) continue
    if (String(signed.record.epoch) !== key) continue
    out.push(signed)
  }
  return out.sort((a, b) => a.record.epoch - b.record.epoch)
}

export function storedSealedKeys(doc: Y.Doc, domain: string): SealedEpochKey[] {
  const out: SealedEpochKey[] = []
  for (const [key, sealed] of keyringMap(doc).entries()) {
    if (sealed?.domain !== domain) continue
    if (sealedKeyId(sealed) !== key) continue
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

export type KeyAccess =
  /** This device holds keys and can read content. */
  | "reader"
  /** Nothing is sealed to this device, so content is unreadable here. */
  | "no-keys"
  /** The stored timeline did not verify. Nothing is derived from it. */
  | "untrusted-timeline"
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

  const sealed = storedSealedKeys(options.doc, domain)
  const { anchors } = await openKeyring(
    sealed,
    domain,
    options.device.record.sealingDid,
    options.device.sealingKey,
  )
  if (anchors.size === 0) {
    return { ...empty, access: "no-keys", timeline, verification }
  }

  const keyring = await readKeysFor(
    timeline,
    sealed,
    options.device.record.sealingDid,
    options.device.sealingKey,
  )
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
