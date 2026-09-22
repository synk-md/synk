/**
 * The sealed keyring: epoch keys sealed to each member's X25519 key.
 *
 * Every copy opens only with its recipient's private key, so the whole keyring
 * can sit in the open on an untrusted relay. Sharing, adding and removing
 * members are all decisions about which sealed copies exist.
 *
 * Domain, epoch and recipient are bound as the sealed box's associated data, so
 * a copy cannot be re-addressed to another member or replayed as the key for a
 * different epoch or notebook.
 */

import {
  fromBase64Url,
  seal,
  toBase64Url,
  utf8,
  type Bytes,
  type SealingKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

export const SEALED_EPOCH_KEY_VERSION = 1

export interface SealedEpochKey {
  v: typeof SEALED_EPOCH_KEY_VERSION
  domain: string
  epoch: number
  /** `did:key` (x25519) of the member this copy is for. */
  recipient: string
  /** base64url sealed box. */
  box: string
}

/** Binds a sealed copy to exactly one domain, epoch and recipient. */
export function sealedKeyAad(domain: string, epoch: number, recipient: string): Bytes {
  return utf8(["synk/sealed-epoch-key/v1", domain, String(epoch), recipient].join("\n"))
}

export async function sealEpochKey(
  domain: string,
  epoch: number,
  recipientSealingDid: string,
  key: Bytes,
): Promise<SealedEpochKey> {
  const recipientPublicKey = publicKeyFromDid(recipientSealingDid, "x25519")
  const box = await seal(recipientPublicKey, key, sealedKeyAad(domain, epoch, recipientSealingDid))
  return {
    v: SEALED_EPOCH_KEY_VERSION,
    domain,
    epoch,
    recipient: recipientSealingDid,
    box: toBase64Url(box),
  }
}

/**
 * Open a copy addressed to this member. Throws when it was not - a mismatched
 * domain, epoch or recipient breaks the associated data and the box refuses.
 */
export async function openEpochKey(
  sealed: SealedEpochKey,
  sealingKey: SealingKey,
): Promise<Bytes> {
  if (sealed.v !== SEALED_EPOCH_KEY_VERSION) {
    throw new Error(`unsupported sealed epoch key version ${String(sealed.v)}`)
  }
  return sealingKey.open(
    fromBase64Url(sealed.box),
    sealedKeyAad(sealed.domain, sealed.epoch, sealed.recipient),
  )
}

/**
 * Open every copy addressed to this member, skipping the rest.
 *
 * Failures are counted rather than thrown: a keyring read from shared state
 * contains copies for everyone, and most of them are not ours.
 */
export async function openKeyring(
  sealed: readonly SealedEpochKey[],
  domain: string,
  sealingDid: string,
  sealingKey: SealingKey,
): Promise<{ anchors: Map<number, Bytes>; skipped: number; failed: number }> {
  const anchors = new Map<number, Bytes>()
  let skipped = 0
  let failed = 0

  for (const copy of sealed) {
    if (copy?.domain !== domain || copy.recipient !== sealingDid) {
      skipped += 1
      continue
    }
    try {
      anchors.set(copy.epoch, await openEpochKey(copy, sealingKey))
    } catch {
      failed += 1
    }
  }
  return { anchors, skipped, failed }
}
