/**
 * A snapshot's content key, and the wraps that make it reachable.
 *
 * Snapshot content is encrypted under its **own** fresh random key rather than
 * directly under an epoch key, and that key is then sealed under one or more
 * epoch keys. One level of indirection, and it changes what admitting somebody
 * costs.
 *
 * Without it, a joiner sealed to a new epoch needs a *fresh snapshot* of every
 * note - open the document, materialise the state, encrypt it again, sign it.
 * With it, a note nobody has touched since its last snapshot needs only its
 * content key re-sealed under the new epoch: one small wrap, no document open,
 * no re-encryption. The snapshot's own signature stays valid because the
 * ciphertext never changes.
 *
 * ## What a rewrap does and does not disclose
 *
 * Rewrapping makes a snapshot readable under a later epoch. That is the point -
 * it is how a joiner gets a baseline - but it is worth being precise about the
 * removed-member case. Somebody removed at epoch N held that epoch's key and so
 * already learned any content key wrapped under it. Rewrapping that same key
 * under N+1 tells them nothing new, because the content has not changed: an
 * unchanged snapshot is the precondition for rewrapping at all. Any edit moves
 * the state vector, which forces a fresh snapshot under a fresh key that the
 * removed member never sees.
 *
 * ## Why the wrap is signed
 *
 * Not for confidentiality - the AEAD already guarantees that a wrap either
 * yields the right key or fails. A member holding the epoch key could wrap the
 * *wrong* key and make a snapshot look openable and then fail, which is a
 * denial of service. The signature makes that attributable rather than
 * anonymous.
 */

import {
  aeadDecrypt,
  aeadEncrypt,
  fromBase64Url,
  generateAeadKey,
  randomNonce,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"
import type { DeliveryVector } from "@/lib/sync"

import type { Snapshot } from "./snapshot"

export const SNAPSHOT_WRAP_VERSION = 1

export interface SnapshotKeyWrapBody {
  v: typeof SNAPSHOT_WRAP_VERSION
  /** The snapshot this unlocks. */
  snapshotId: string
  domain: string
  /** Epoch whose key seals the content key. */
  epoch: number
  /** base64url AEAD of the content key under that epoch key. */
  wrapped: string
  nonce: string
  /** `did:key` of the device that produced this wrap. */
  wrapper: string
  createdAt: number
}

export interface SnapshotKeyWrap extends SnapshotKeyWrapBody {
  sig: string
}

/** Binds a wrap to one snapshot, domain and epoch. It cannot be lifted. */
export function wrapAad(snapshotId: string, domain: string, epoch: number): Bytes {
  return utf8(["synk/snapshot-key-wrap/v1", snapshotId, domain, String(epoch)].join("\n"))
}

export function wrapBytes(body: SnapshotKeyWrapBody): Bytes {
  return utf8(
    [
      "synk/snapshot-wrap/v1",
      String(body.v),
      body.snapshotId,
      body.domain,
      String(body.epoch),
      body.wrapped,
      body.nonce,
      body.wrapper,
      String(body.createdAt),
    ].join("\n"),
  )
}

/** A fresh content key. One per snapshot, never derived from an epoch. */
export function generateSnapshotKey(): Bytes {
  return generateAeadKey()
}

export interface WrapOptions {
  snapshotId: string
  domain: string
  epoch: number
  /** The epoch key doing the sealing. */
  epochKey: Bytes
  /** The snapshot's own content key. */
  contentKey: Bytes
  signingKey: SigningKey
  wrapper: string
  createdAt?: number
  nonce?: Bytes
}

export async function wrapSnapshotKey(options: WrapOptions): Promise<SnapshotKeyWrap> {
  const nonce = options.nonce ?? randomNonce()
  const body: SnapshotKeyWrapBody = {
    v: SNAPSHOT_WRAP_VERSION,
    snapshotId: options.snapshotId,
    domain: options.domain,
    epoch: options.epoch,
    wrapped: toBase64Url(
      await aeadEncrypt(
        options.epochKey,
        nonce,
        options.contentKey,
        wrapAad(options.snapshotId, options.domain, options.epoch),
      ),
    ),
    nonce: toBase64Url(nonce),
    wrapper: options.wrapper,
    createdAt: options.createdAt ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(wrapBytes(body))) }
}

/** Recover the content key. Throws when this epoch key is not the one. */
export async function unwrapSnapshotKey(
  wrap: SnapshotKeyWrap,
  epochKey: Bytes,
): Promise<Bytes> {
  if (wrap.v !== SNAPSHOT_WRAP_VERSION) {
    throw new Error(`unsupported snapshot wrap version ${String(wrap.v)}`)
  }
  return aeadDecrypt(
    epochKey,
    fromBase64Url(wrap.nonce),
    fromBase64Url(wrap.wrapped),
    wrapAad(wrap.snapshotId, wrap.domain, wrap.epoch),
  )
}

/** Authorship of a wrap. The AEAD is what protects correctness; this attributes it. */
export async function verifySnapshotWrap(wrap: SnapshotKeyWrap): Promise<boolean> {
  try {
    if (wrap.v !== SNAPSHOT_WRAP_VERSION) return false
    const { sig, ...body } = wrap
    return await verifySignature(
      publicKeyFromDid(wrap.wrapper, "ed25519"),
      wrapBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

/** Wraps for this snapshot under an epoch the holder can reach, newest first. */
export function reachableWraps(
  wraps: readonly SnapshotKeyWrap[],
  snapshotId: string,
  readableEpochs: Iterable<number>,
): SnapshotKeyWrap[] {
  const readable = new Set(readableEpochs)
  return wraps
    .filter((wrap) => wrap.snapshotId === snapshotId && readable.has(wrap.epoch))
    .sort((a, b) => b.epoch - a.epoch)
}

/**
 * Re-seal an existing content key under another epoch.
 *
 * The whole optimisation: no document is opened, nothing is re-encrypted, and
 * the snapshot's signature is untouched because the snapshot itself does not
 * change.
 */
export async function rewrapForEpoch(options: {
  wrap: SnapshotKeyWrap
  /** Key for the epoch the existing wrap names, to open it. */
  fromEpochKey: Bytes
  toEpoch: number
  toEpochKey: Bytes
  signingKey: SigningKey
  wrapper: string
  createdAt?: number
}): Promise<SnapshotKeyWrap> {
  const contentKey = await unwrapSnapshotKey(options.wrap, options.fromEpochKey)
  return wrapSnapshotKey({
    snapshotId: options.wrap.snapshotId,
    domain: options.wrap.domain,
    epoch: options.toEpoch,
    epochKey: options.toEpochKey,
    contentKey,
    signingKey: options.signingKey,
    wrapper: options.wrapper,
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  })
}

/**
 * May this snapshot stand in for a fresh one?
 *
 * Only on exact equality. A snapshot lagging even one operation leaves a causal
 * gap for that operation's author, which is precisely the deafness a joiner
 * snapshot exists to prevent - so "close enough" is not a state this can have.
 *
 * The comparison is metadata on both sides, so an admin can decide which notes
 * qualify without opening any of them. That is what makes the optimisation
 * worth having.
 */
export function coversCurrentState(
  snapshot: Pick<Snapshot, "covers">,
  current: DeliveryVector,
): boolean {
  const authors = new Set([...Object.keys(snapshot.covers), ...Object.keys(current)])
  for (const author of authors) {
    if ((snapshot.covers[author] ?? 0) !== (current[author] ?? 0)) return false
  }
  return true
}
