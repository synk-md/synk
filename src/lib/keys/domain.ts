/**
 * A key domain's lifecycle: a notebook, or a note promoted to its own key.
 *
 * `KeyDomainAdmin` is the writer's view - it holds current key material and
 * cuts epochs. `readKeysFor` builds the reader's view from a keyring and a
 * timeline, and is all a member needs to decrypt.
 */

import { generateAeadKey, type Bytes, type SealingKey } from "@/lib/crypto"
import {
  deriveChainedEpochKey,
  epochKeyCommitment,
  generateEpochSeed,
  genesisEpoch,
  reachableEpochs,
  resolveEpochKey,
  type EpochReason,
  type EpochRecord,
  type EpochTimeline,
} from "./epochs"
import { openKeyring, sealEpochKey, type SealedEpochKey } from "./keyring"

/** One member's sealing identity, as published in the directory. */
export interface KeyRecipient {
  /** `did:key` (x25519). Where their copy is sealed. */
  sealingDid: string
}

export interface CutEpochResult {
  record: EpochRecord
  /** The new epoch's key. */
  key: Bytes
  /** Copies produced for this cut. Empty when everyone can derive it. */
  sealed: SealedEpochKey[]
}

/**
 * A cut computed but not yet applied, so a caller producing something else
 * alongside it - a joiner snapshot - can build everything first and advance the
 * timeline only once it all succeeded. Without staging, a failure after the cut
 * would leave an epoch published with no usable snapshot behind it.
 */
export interface StagedEpoch extends CutEpochResult {
  /** Advance the domain. Idempotent; calling it twice is a no-op. */
  commit(): void
}

/**
 * The writer's view of a domain. Holds live key material, so it exists only on
 * a device that legitimately has it.
 */
export class KeyDomainAdmin {
  readonly domain: string
  private readonly records: EpochRecord[] = []
  private readonly keys = new Map<number, Bytes>()

  private constructor(domain: string) {
    this.domain = domain
  }

  /** Start a domain. The genesis key is sealed to the founding members. */
  static async create(
    domain: string,
    founders: readonly KeyRecipient[],
    options: { createdAt?: number; key?: Bytes } = {},
  ): Promise<{ admin: KeyDomainAdmin; sealed: SealedEpochKey[] }> {
    const admin = new KeyDomainAdmin(domain)
    const key = options.key ?? generateAeadKey()
    const record = { ...genesisEpoch(domain, options.createdAt), commitment: await epochKeyCommitment(key) }
    admin.records.push(record)
    admin.keys.set(1, key)

    const sealed = await Promise.all(
      founders.map((member) => sealEpochKey(domain, 1, member.sealingDid, key)),
    )
    return { admin, sealed }
  }

  /** Rebuild the writer's view from a timeline plus the keys this device holds. */
  static restore(timeline: EpochTimeline, keys: ReadonlyMap<number, Bytes>): KeyDomainAdmin {
    const admin = new KeyDomainAdmin(timeline[0].domain)
    admin.records.push(...timeline)
    for (const [epoch, key] of keys) admin.keys.set(epoch, key)
    return admin
  }

  get timeline(): EpochTimeline {
    return this.records
  }

  get currentEpoch(): number {
    return this.records.length
  }

  async currentKey(): Promise<Bytes> {
    const key = await resolveEpochKey(this.records, this.keys, this.currentEpoch)
    if (!key) throw new Error(`no key held for the current epoch of ${this.domain}`)
    return key
  }

  /**
   * Add a member.
   *
   * Cuts a `chain` epoch, so every existing member derives the new key
   * themselves and only the joiner needs a sealed copy. The chain is one-way,
   * so the joiner cannot reach anything before this point - history excluded by
   * default, cryptographically rather than by client policy.
   *
   * The joiner still needs a snapshot of current content under this key, since
   * the envelopes behind it are sealed under epochs they cannot open. That
   * snapshot is M9's.
   */
  async addMember(
    joiner: KeyRecipient,
    options: { createdAt?: number } = {},
  ): Promise<CutEpochResult> {
    const staged = await this.stageAddMember(joiner, options)
    staged.commit()
    return staged
  }

  /**
   * Compute the join cut without applying it. See `StagedEpoch`.
   */
  async stageAddMember(
    joiner: KeyRecipient,
    options: { createdAt?: number } = {},
  ): Promise<StagedEpoch> {
    const key = await deriveChainedEpochKey(await this.currentKey())
    const record = await this.committed(this.nextRecord("chain", "member-added", options.createdAt), key)
    const sealed = [await sealEpochKey(this.domain, record.epoch, joiner.sealingDid, key)]
    return { record, key, sealed, commit: this.committer(record, key) }
  }

  /**
   * A chain step with nobody joining, so a domain whose current epoch predates
   * commitments gets one. Everyone derives the new key themselves, so nothing
   * is sealed - and a device holding a planted key derives one that fails it.
   */
  async stageCommitment(options: { createdAt?: number } = {}): Promise<StagedEpoch> {
    const key = await deriveChainedEpochKey(await this.currentKey())
    const record = await this.committed(this.nextRecord("chain", "key-commitment", options.createdAt), key)
    return { record, key, sealed: [], commit: this.committer(record, key) }
  }

  /**
   * Remove a member.
   *
   * Cuts a `rotation` epoch from a fresh seed and flat-reseals to everyone who
   * remains. The removed member holds keys the chain no longer reaches from, so
   * they cannot derive this or any later epoch however long they keep what they
   * already had.
   *
   * This is the expensive path - O(remaining members) seals - and the reason
   * joins deliberately take the cheap one. It is also where a tree scheme
   * (BeeKEM) would slot in behind `ReadKeySource` to make it O(log n).
   */
  async removeMember(
    remaining: readonly KeyRecipient[],
    options: { createdAt?: number } = {},
  ): Promise<CutEpochResult> {
    const key = generateEpochSeed()
    const record = this.push(await this.committed(this.nextRecord("rotation", "member-removed", options.createdAt), key))
    this.keys.set(record.epoch, key)
    return {
      record,
      key,
      sealed: await Promise.all(
        remaining.map((member) => sealEpochKey(this.domain, record.epoch, member.sealingDid, key)),
      ),
    }
  }

  /** Rotate without a membership change - after a suspected compromise, or a lost device. */
  async rotate(
    members: readonly KeyRecipient[],
    options: { createdAt?: number; reason?: "manual-rotation" | "device-unlinked" | "owner-succeeded" } = {},
  ): Promise<CutEpochResult> {
    const key = generateEpochSeed()
    const record = this.push(
      await this.committed(this.nextRecord("rotation", options.reason ?? "manual-rotation", options.createdAt), key),
    )
    this.keys.set(record.epoch, key)
    return {
      record,
      key,
      sealed: await Promise.all(
        members.map((member) => sealEpochKey(this.domain, record.epoch, member.sealingDid, key)),
      ),
    }
  }

  keyFor(epoch: number): Promise<Bytes | undefined> {
    return resolveEpochKey(this.records, this.keys, epoch)
  }

  private push(record: EpochRecord): EpochRecord {
    this.records.push(record)
    return record
  }

  private async committed(record: EpochRecord, key: Bytes): Promise<EpochRecord> {
    return { ...record, commitment: await epochKeyCommitment(key) }
  }

  private nextRecord(
    kind: "chain" | "rotation",
    reason: EpochReason,
    createdAt?: number,
  ): EpochRecord {
    return {
      v: 1,
      domain: this.domain,
      epoch: this.records.length + 1,
      kind,
      reason,
      createdAt: createdAt ?? Date.now(),
    }
  }

  private committer(record: EpochRecord, key: Bytes): () => void {
    return () => {
      if (this.records.length >= record.epoch) return
      this.records.push(record)
      this.keys.set(record.epoch, key)
    }
  }
}

/**
 * The read-key interface.
 *
 * Deliberately narrow: "give me the key for this epoch, if I can reach it."
 * Everything about *how* a member came to hold keys - flat reseal today, a
 * tree scheme later - sits behind it, so replacing the mechanism does not touch
 * the envelope layer.
 */
export interface ReadKeySource {
  readonly domain: string
  readonly currentEpoch: number
  keyFor(epoch: number): Promise<Bytes | undefined>
  /** Every epoch this member can open. What they can decrypt, exactly. */
  readableEpochs(): number[]
}

export class FlatKeyring implements ReadKeySource {
  readonly domain: string
  private currentTimeline: EpochTimeline
  private readonly anchors: Map<number, Bytes>
  private derived = new Map<number, Bytes>()
  /**
   * Epochs destroyed by erasure. Sticky, because the sealed copies are still on
   * the relay: without this, the next refresh re-opens them and quietly undoes
   * the erasure.
   */
  private readonly destroyed: Set<number>

  constructor(timeline: EpochTimeline, anchors: Map<number, Bytes>, destroyed?: Iterable<number>) {
    this.domain = timeline[0].domain
    this.currentTimeline = timeline
    this.anchors = anchors
    this.destroyed = new Set(destroyed ?? [])
    for (const epoch of this.destroyed) this.anchors.delete(epoch)
  }

  /** Forget these epochs and refuse to take them back. */
  forget(epochs: Iterable<number>): void {
    for (const epoch of epochs) {
      this.destroyed.add(epoch)
      this.anchors.delete(epoch)
      this.derived.delete(epoch)
    }
  }

  /** What has been destroyed here, so a caller can persist it. */
  get destroyedEpochs(): number[] {
    return [...this.destroyed].sort((a, b) => a - b)
  }

  get timeline(): EpochTimeline {
    return this.currentTimeline
  }

  /**
   * Adopt a newer timeline and any copies since sealed to this member.
   *
   * A keyring view is a snapshot of shared state, and shared state moves: every
   * membership change cuts an epoch. A member who does not refresh keeps
   * sealing under a superseded epoch, producing content that recent joiners
   * cannot read - so this is not an optimisation, it is what keeps a writer
   * current. Call it whenever the timeline or keyring changes.
   */
  refresh(timeline: EpochTimeline, anchors?: ReadonlyMap<number, Bytes>): void {
    if (timeline[0].domain !== this.domain) {
      throw new Error(`refusing to refresh ${this.domain} with a timeline for ${timeline[0].domain}`)
    }
    this.currentTimeline = timeline
    if (anchors) {
      for (const [epoch, key] of anchors) {
        if (this.destroyed.has(epoch)) continue
        this.anchors.set(epoch, key)
      }
    }
    // Segment boundaries can only be appended, never rewritten, so derivations
    // stay valid - but recomputing is cheap and removes the need to reason
    // about it at every call site.
    this.derived = new Map()
  }

  get currentEpoch(): number {
    return this.currentTimeline.length
  }

  /** Epochs whose key was sealed directly to this member. */
  get anchorEpochs(): number[] {
    return [...this.anchors.keys()].sort((a, b) => a - b)
  }

  async keyFor(epoch: number): Promise<Bytes | undefined> {
    // Refused even when an earlier anchor could derive it. The scope
    // calculation is meant to have removed those anchors too; this is the
    // second line rather than the only one.
    if (this.destroyed.has(epoch)) return undefined
    const cached = this.derived.get(epoch)
    if (cached) return cached
    const key = await resolveEpochKey(this.currentTimeline, this.anchors, epoch)
    if (key) this.derived.set(epoch, key)
    return key
  }

  readableEpochs(): number[] {
    return reachableEpochs(this.currentTimeline, this.anchors).filter(
      (epoch) => !this.destroyed.has(epoch),
    )
  }
}

/** Re-open the keyring and fold the result into an existing view. */
export async function refreshKeysFor(
  keyring: FlatKeyring,
  timeline: EpochTimeline,
  sealed: readonly SealedEpochKey[],
  sealingDid: string,
  sealingKey: SealingKey,
): Promise<FlatKeyring> {
  const { anchors } = await openKeyring(sealed, timeline[0].domain, sealingDid, sealingKey)
  keyring.refresh(timeline, anchors)
  return keyring
}

/** Build a member's read view from the published keyring. */
export async function readKeysFor(
  timeline: EpochTimeline,
  sealed: readonly SealedEpochKey[],
  sealingDid: string,
  sealingKey: SealingKey,
  /** Previously destroyed epochs, so a reload does not resurrect them. */
  destroyed?: Iterable<number>,
): Promise<FlatKeyring> {
  const { anchors } = await openKeyring(sealed, timeline[0].domain, sealingDid, sealingKey)
  return new FlatKeyring(timeline, anchors, destroyed)
}
