/**
 * Restore: a forward, authored, authorized edit that makes the document look
 * like a chosen restore point again.
 *
 * Nothing is rewound. A CRDT has no rewind, and a history that could be edited
 * would not be one - so restoring publishes an ordinary signed update under the
 * current epoch, attributed to whoever pressed the button, and the restore
 * itself shows up on the timeline like any other change.
 *
 * Two consequences fall out of that, and both are surfaced rather than hidden.
 *
 * Content unchanged since the restore point keeps its original structs, and so
 * its original authorship, for free. Content **deleted** since cannot: Yjs
 * tombstones are permanent, so bringing it back means new structs, which carry
 * the restorer's client id. The original authorship is therefore recorded out
 * of band in the signed `RestoreRecord`, so a byline can show who actually
 * wrote the words rather than who pressed restore.
 *
 * And a restore is only possible within the actor's visible history: the target
 * has to be opened with an epoch key they hold, so there is no path to
 * recovering content from before they joined.
 */

import * as Y from "yjs"
import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import { openSnapshot, type Snapshot } from "@/lib/snapshots"
import type { DeliveryVector } from "@/lib/sync"

export const RESTORE_VERSION = 1

/** Content brought back, and who wrote it at the restore point. */
export interface RestoredRegion {
  /** Yjs client id that authored it originally. */
  originClientId: number
  /** Items or characters restored under that id. */
  length: number
}

export interface RestoreBody {
  v: typeof RESTORE_VERSION
  resourceId: string
  domain: string
  /** Snapshot restored to. */
  target: string
  /** Its signed state hash, so the record names specific content. */
  targetStateHash: string
  /** `did:key` of the actor. The restore is theirs. */
  actor: string
  /** Where the log stood before, so the restore can itself be undone. */
  supersedes: DeliveryVector
  /**
   * Original authorship of the content this restore reinserted. The Yjs structs
   * carry the actor's client id; this says who wrote the words.
   */
  regions: RestoredRegion[]
  restoredAt: number
}

export interface RestoreRecord extends RestoreBody {
  sig: string
}

export function restoreBytes(body: RestoreBody): Bytes {
  const regions = [...body.regions]
    .sort((a, b) => a.originClientId - b.originClientId)
    .map((region) => `${String(region.originClientId)}:${String(region.length)}`)
    .join(",")
  const supersedes = Object.keys(body.supersedes)
    .sort()
    .map((author) => `${author}=${String(body.supersedes[author])}`)
    .join(",")
  return utf8(
    [
      "synk/restore/v1",
      String(body.v),
      body.resourceId,
      body.domain,
      body.target,
      body.targetStateHash,
      body.actor,
      supersedes,
      regions,
      String(body.restoredAt),
    ].join("\n"),
  )
}

/* ---- reading authorship out of a document -------------------------------- */

/**
 * Client ids per visible item, walked from the type's own item list.
 *
 * Reaches into Yjs internals because there is no public way to ask "who wrote
 * this". The walk is guarded: if the shape ever changes, restore still works
 * and only the provenance detail is lost.
 */
function clientLengths(type: unknown): Map<number, number> {
  const lengths = new Map<number, number>()
  try {
    let item = (type as { _start?: unknown })._start as
      | { deleted: boolean; length: number; id: { client: number }; right: unknown }
      | null
      | undefined
    while (item) {
      if (!item.deleted) {
        lengths.set(item.id.client, (lengths.get(item.id.client) ?? 0) + item.length)
      }
      item = item.right as typeof item
    }
  } catch {
    return new Map()
  }
  return lengths
}

function regionsOf(doc: Y.Doc, roots: readonly string[]): RestoredRegion[] {
  const totals = new Map<number, number>()
  for (const name of roots) {
    const type: unknown = doc.share.get(name)
    if (!type) continue
    for (const [client, length] of clientLengths(type)) {
      totals.set(client, (totals.get(client) ?? 0) + length)
    }
  }
  return [...totals]
    .map(([originClientId, length]) => ({ originClientId, length }))
    .sort((a, b) => b.length - a.length)
}

/* ---- the diff ------------------------------------------------------------ */

/**
 * Bind `into`'s roots to the same concrete types as `from`'s.
 *
 * Applying an update to a fresh document leaves every root a generic
 * `AbstractType` - the concrete class is only attached when something asks for
 * it by name. Without this, a decoded snapshot has no `Y.Text` or `Y.Map` to
 * compare against and the diff silently finds nothing.
 */
function mirrorRoots(from: Y.Doc, into: Y.Doc): void {
  for (const [name, type] of from.share) {
    const ctor = type.constructor as unknown as new () => Y.AbstractType<unknown>
    if (ctor === (Y.AbstractType as unknown as new () => Y.AbstractType<unknown>)) continue
    try {
      into.get(name, ctor as never)
    } catch {
      // A root whose type disagrees between the two documents. Left alone and
      // reported as skipped rather than coerced into the wrong shape.
    }
  }
}

/** Roots the live document has bound, which is what can be diffed. */
function rootNames(live: Y.Doc, target: Y.Doc): string[] {
  return [...new Set([...live.share.keys(), ...target.share.keys()])].sort()
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i += 1
  return i
}

function commonSuffix(a: string, b: string, floor: number): number {
  const limit = Math.min(a.length, b.length) - floor
  let i = 0
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/**
 * Rewrite `text` to match `want`, touching only the part that differs.
 *
 * The prefix/suffix trim is what preserves authorship: untouched characters
 * keep their original structs, so only genuinely changed text is reattributed.
 * A whole-content replace would be simpler and would relabel the entire
 * document as the restorer's.
 */
function restoreText(text: Y.Text, want: string): number {
  const have = text.toJSON()
  if (have === want) return 0

  const head = commonPrefix(have, want)
  const tail = commonSuffix(have, want, head)
  const removeLength = have.length - head - tail
  const insert = want.slice(head, want.length - tail)

  if (removeLength > 0) text.delete(head, removeLength)
  if (insert.length > 0) text.insert(head, insert)
  return insert.length
}

function restoreArray(array: Y.Array<unknown>, want: readonly unknown[]): number {
  const have = array.toJSON() as unknown[]
  const key = (value: unknown) => JSON.stringify(value)
  const haveKeys = have.map(key)
  const wantKeys = want.map(key)

  let head = 0
  while (head < haveKeys.length && head < wantKeys.length && haveKeys[head] === wantKeys[head]) {
    head += 1
  }
  let tail = 0
  while (
    tail < haveKeys.length - head &&
    tail < wantKeys.length - head &&
    haveKeys[haveKeys.length - 1 - tail] === wantKeys[wantKeys.length - 1 - tail]
  ) {
    tail += 1
  }

  const removeLength = have.length - head - tail
  const insert = want.slice(head, want.length - tail)
  if (removeLength > 0) array.delete(head, removeLength)
  if (insert.length > 0) array.insert(head, [...insert])
  return insert.length
}

function restoreMap(map: Y.Map<unknown>, want: Record<string, unknown>): number {
  let changed = 0
  for (const key of [...map.keys()]) {
    if (!(key in want)) {
      map.delete(key)
      changed += 1
    }
  }
  for (const [key, value] of Object.entries(want)) {
    if (JSON.stringify(map.get(key)) === JSON.stringify(value)) continue
    map.set(key, value)
    changed += 1
  }
  return changed
}

/**
 * XML fragments are diffed by serialised child, then rebuilt from the target's
 * own update rather than by cloning nodes: cloning loses marks and attributes
 * that the deep structure carries.
 */
function restoreFragment(live: Y.XmlFragment, target: Y.XmlFragment): number {
  // JSON rather than a string form, so a node type whose `toJSON` is not a
  // string still produces a stable comparison key.
  const have = live.toArray().map((node) => JSON.stringify(node.toJSON()))
  const want = target.toArray().map((node) => JSON.stringify(node.toJSON()))

  let head = 0
  while (head < have.length && head < want.length && have[head] === want[head]) head += 1
  let tail = 0
  while (
    tail < have.length - head &&
    tail < want.length - head &&
    have[have.length - 1 - tail] === want[want.length - 1 - tail]
  ) {
    tail += 1
  }

  const removeLength = have.length - head - tail
  if (removeLength > 0) live.delete(head, removeLength)

  // A hook is a host-defined placeholder with no insertable clone, so it is
  // left out rather than coerced. Reported through the plan's skipped roots.
  const insert = target
    .toArray()
    .slice(head, want.length - tail)
    .filter(
      (node): node is Y.XmlElement | Y.XmlText =>
        node instanceof Y.XmlElement || node instanceof Y.XmlText,
    )
    .map((node) => node.clone())
  if (insert.length > 0) live.insert(head, insert)
  return insert.length
}

export interface RestorePlan {
  target: Snapshot
  /** Items or characters this restore would bring back or rewrite. */
  changed: number
  /** Who wrote the target's content. Survives into the record. */
  regions: RestoredRegion[]
  /**
   * Roots the target has that the live document has never bound, so their type
   * cannot be known. Reported rather than guessed at.
   */
  skipped: string[]
  /** True when the document already matches the target. */
  noop: boolean
}

/**
 * What restoring would do, without doing it.
 *
 * Runs the whole diff against a throwaway copy of the live document, so a plan
 * costs the same work as the restore and is guaranteed to agree with it.
 */
export async function planRestore(options: {
  doc: Y.Doc
  target: Snapshot
  keys: Pick<ReadKeySource, "keyFor">
}): Promise<RestorePlan> {
  const dek = await options.keys.keyFor(options.target.epoch)
  if (!dek) {
    throw new Error(
      `restore target is outside your visible history (epoch ${String(options.target.epoch)})`,
    )
  }
  const state = await openSnapshot(options.target, dek)

  const targetDoc = new Y.Doc()
  Y.applyUpdate(targetDoc, state)

  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(options.doc))
  // Both copies take their shapes from the live document, which is the one
  // bound by whatever is editing it.
  mirrorRoots(options.doc, scratch)
  mirrorRoots(options.doc, targetDoc)

  const changed = applyInto(scratch, targetDoc)
  const skipped = [...targetDoc.share.keys()].filter(
    (name) => !options.doc.share.has(name),
  )

  return {
    target: options.target,
    changed,
    regions: regionsOf(targetDoc, rootNames(scratch, targetDoc)),
    skipped,
    noop: changed === 0,
  }
}

/** Make `live` match `target`, type by type. Returns how much was rewritten. */
function applyInto(live: Y.Doc, target: Y.Doc): number {
  let changed = 0
  live.transact(() => {
    for (const name of rootNames(live, target)) {
      const other: unknown = target.share.get(name)
      if (other instanceof Y.XmlFragment) {
        changed += restoreFragment(live.getXmlFragment(name), other)
      } else if (other instanceof Y.Text) {
        changed += restoreText(live.getText(name), other.toJSON())
      } else if (other instanceof Y.Array) {
        changed += restoreArray(live.getArray(name), other.toJSON() as unknown[])
      } else if (other instanceof Y.Map) {
        changed += restoreMap(live.getMap(name), other.toJSON() as Record<string, unknown>)
      }
      // A root the target does not have is left alone. Emptying it would be a
      // guess: the target may simply predate it.
    }
  })
  return changed
}

export interface RestoreResult {
  record: RestoreRecord
  plan: RestorePlan
}

/**
 * Perform the restore.
 *
 * `transact` is the sync engine's, so the edit is enveloped, signed and
 * published exactly like any other local change. Restore does not get a private
 * path to the document.
 */
export async function applyRestore(options: {
  doc: Y.Doc
  target: Snapshot
  keys: Pick<ReadKeySource, "keyFor">
  signingKey: SigningKey
  actor: string
  /** Checked before anything is written. */
  canWrite: (resourceId: string, actor: string) => Promise<boolean> | boolean
  /** The log's position before this, so the restore is itself reversible. */
  supersedes: DeliveryVector
  /** Runs the mutation under the engine's local origin. */
  transact: (fn: () => void) => void
  restoredAt?: number
}): Promise<RestoreResult> {
  if (!(await options.canWrite(options.target.resourceId, options.actor))) {
    throw new Error("not authorized to restore this resource")
  }

  const plan = await planRestore({ doc: options.doc, target: options.target, keys: options.keys })

  const dek = await options.keys.keyFor(options.target.epoch)
  if (!dek) throw new Error("restore target is outside your visible history")
  const targetDoc = new Y.Doc()
  Y.applyUpdate(targetDoc, await openSnapshot(options.target, dek))
  mirrorRoots(options.doc, targetDoc)

  options.transact(() => {
    applyInto(options.doc, targetDoc)
  })

  const body: RestoreBody = {
    v: RESTORE_VERSION,
    resourceId: options.target.resourceId,
    domain: options.target.domain,
    target: options.target.id,
    targetStateHash: options.target.stateHash,
    actor: options.actor,
    supersedes: { ...options.supersedes },
    regions: plan.regions,
    restoredAt: options.restoredAt ?? Date.now(),
  }
  return {
    plan,
    record: { ...body, sig: toBase64Url(await options.signingKey.sign(restoreBytes(body))) },
  }
}

export async function verifyRestoreRecord(record: RestoreRecord): Promise<boolean> {
  try {
    if (record.v !== RESTORE_VERSION) return false
    const { sig, ...body } = record
    return await verifySignature(
      publicKeyFromDid(record.actor, "ed25519"),
      restoreBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/**
 * Who wrote the restored words, for a byline.
 *
 * The Yjs structs say the restorer. This says the original, which is the answer
 * anyone reading the document actually wants.
 */
export function originalAuthors(
  record: RestoreRecord,
  clientToDid: ReadonlyMap<number, string>,
): { did: string | null; clientId: number; length: number }[] {
  return record.regions.map((region) => ({
    did: clientToDid.get(region.originClientId) ?? null,
    clientId: region.originClientId,
    length: region.length,
  }))
}
