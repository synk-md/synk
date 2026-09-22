/**
 * Published prekeys, so an epoch key can be sealed to a member who is offline.
 *
 * A bundle is signed by the owning device: a medium-term signed prekey that is
 * always available, plus an optional pool of one-time prekeys. Sealing prefers
 * a one-time key and falls back to the signed prekey when the pool is empty,
 * so addition never blocks on the recipient being reachable.
 *
 * Worth being honest about what this buys. The design has no forward secrecy as
 * a stated non-goal, and a device record already names a long-term sealing key
 * that anyone could seal to. So prekeys are not buying FS here. They buy key
 * hygiene - one sealing target is not reused across every member addition
 * forever - and rotation without changing device identity, which the long-term
 * key in the device record cannot offer. If the FS non-goal is ever revisited,
 * the publication mechanism is already in place.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid, type DeviceRecord } from "@/lib/identity"

export const PREKEY_BUNDLE_VERSION = 1

/** Default validity for a signed prekey before it should be rotated. */
export const DEFAULT_PREKEY_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface PrekeyBundleBody {
  v: typeof PREKEY_BUNDLE_VERSION
  /** `did:key` of the device publishing these. */
  did: string
  /** Medium-term X25519 key, always available as a fallback. */
  signedPrekey: string
  /** One-time X25519 keys, consumed in order. May be empty. */
  oneTimePrekeys: string[]
  publishedAt: number
  expiresAt: number
}

export interface PrekeyBundle extends PrekeyBundleBody {
  /** Signature by the publishing device's signing key. */
  sig: string
}

export function prekeyBundleBytes(body: PrekeyBundleBody): Bytes {
  return utf8(
    [
      "synk/prekey-bundle/v1",
      String(body.v),
      body.did,
      body.signedPrekey,
      // Joined with a separator that cannot appear in a did:key, so two
      // different pools can never serialise to the same bytes.
      body.oneTimePrekeys.join(","),
      String(body.publishedAt),
      String(body.expiresAt),
    ].join("\n"),
  )
}

export interface PublishPrekeysOptions {
  /** The publishing device's signing key. */
  signingKey: SigningKey
  /** That device's record, naming the DID the bundle is published under. */
  record: DeviceRecord
  /** `did:key` (x25519) of the medium-term signed prekey. */
  signedPrekey: string
  oneTimePrekeys?: string[]
  publishedAt?: number
  ttlMs?: number
}

/**
 * Publish a bundle. Signed by the device itself - a prekey is a claim about
 * where to seal to that device, so only that device may make it.
 */
export async function publishPrekeys(options: PublishPrekeysOptions): Promise<PrekeyBundle> {
  const { signingKey, record, signedPrekey } = options
  const oneTimePrekeys = options.oneTimePrekeys ?? []

  const devicePublicKey = publicKeyFromDid(record.did, "ed25519")
  if (toBase64Url(devicePublicKey) !== toBase64Url(signingKey.publicKey)) {
    throw new Error("record does not match the supplied signing key")
  }
  // Every entry must be a sealing key. A signing DID here would produce a
  // bundle nobody can seal to, discovered only at decryption time.
  publicKeyFromDid(signedPrekey, "x25519")
  for (const prekey of oneTimePrekeys) publicKeyFromDid(prekey, "x25519")
  if (new Set(oneTimePrekeys).size !== oneTimePrekeys.length) {
    throw new Error("one-time prekeys must be distinct")
  }

  const publishedAt = options.publishedAt ?? Date.now()
  const body: PrekeyBundleBody = {
    v: PREKEY_BUNDLE_VERSION,
    did: record.did,
    signedPrekey,
    oneTimePrekeys,
    publishedAt,
    expiresAt: publishedAt + (options.ttlMs ?? DEFAULT_PREKEY_TTL_MS),
  }
  return { ...body, sig: toBase64Url(await signingKey.sign(prekeyBundleBytes(body))) }
}

export interface VerifyPrekeyBundleOptions {
  now?: number
  /** Accept an expired bundle. Only for inspecting history, never for sealing. */
  allowExpired?: boolean
}

export async function verifyPrekeyBundle(
  bundle: PrekeyBundle,
  options: VerifyPrekeyBundleOptions = {},
): Promise<boolean> {
  try {
    if (bundle.v !== PREKEY_BUNDLE_VERSION) return false
    if (!Array.isArray(bundle.oneTimePrekeys)) return false
    if (new Set(bundle.oneTimePrekeys).size !== bundle.oneTimePrekeys.length) return false

    const now = options.now ?? Date.now()
    if (!options.allowExpired && now >= bundle.expiresAt) return false

    publicKeyFromDid(bundle.signedPrekey, "x25519")
    for (const prekey of bundle.oneTimePrekeys) publicKeyFromDid(prekey, "x25519")

    const devicePublicKey = publicKeyFromDid(bundle.did, "ed25519")
    const { sig, ...body } = bundle
    return await verifySignature(devicePublicKey, prekeyBundleBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

export interface SealingTarget {
  /** `did:key` (x25519) to seal to. */
  prekey: string
  kind: "one-time" | "signed"
}

/**
 * Pick where to seal. Prefers an unconsumed one-time key, falls back to the
 * signed prekey so an addition never blocks on the pool being empty.
 *
 * Consumption is advisory. The directory's merge is untrusted and two admins
 * can pick the same one-time key concurrently; with no forward secrecy on the
 * table that costs nothing beyond the hygiene the pool was buying, so it is
 * tolerated rather than coordinated.
 */
export function selectSealingTarget(
  bundle: PrekeyBundle,
  consumed: readonly string[] = [],
): SealingTarget {
  const spent = new Set(consumed)
  const available = bundle.oneTimePrekeys.find((prekey) => !spent.has(prekey))
  return available
    ? { prekey: available, kind: "one-time" }
    : { prekey: bundle.signedPrekey, kind: "signed" }
}

/** How many one-time keys remain, for deciding when to republish. */
export function remainingOneTimePrekeys(
  bundle: PrekeyBundle,
  consumed: readonly string[] = [],
): number {
  const spent = new Set(consumed)
  return bundle.oneTimePrekeys.filter((prekey) => !spent.has(prekey)).length
}
