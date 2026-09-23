/**
 * A short, human-comparable fingerprint of a device key.
 *
 * Approving a new device means approving a *specific* public key. The person
 * doing the approving has to be able to check that the key their screen names
 * is the key on the device in front of them - otherwise an attacker who can get
 * an approval prompt raised gets linked instead. Comparing full `did:key`
 * strings out loud is not something anyone will actually do.
 *
 * ## Why 80 bits
 *
 * The attack is a second preimage on the truncated digest: the attacker
 * generates candidate keypairs until one's fingerprint matches the victim's,
 * then gets that key approved in its place. The work is ~2^n for n bits shown,
 * and each try is one keygen plus one SHA-256 - cheap, parallel, and entirely
 * offline.
 *
 *   40 bits (8 chars)   ~10^12 tries. Hours on a single GPU. Grindable.
 *   60 bits (12 chars)  ~10^18 tries. Weeks on a rented farm. Uncomfortable.
 *   80 bits (16 chars)  ~10^24 tries. Not worth grinding, by a wide margin.
 *
 * So the displayed length is the security parameter, not a layout choice, and
 * shortening it to fit a design is a security change. Sixteen characters is
 * four groups of four - the length of a product key, typed once per device.
 *
 * ## Why the label
 *
 * The digest is domain-separated with a version label, like every other hashed
 * structure in this codebase. Without it the fingerprint is just SHA-256 of a
 * DID string, which is a value anything else might also compute - and a grind
 * against one use would be a grind against all of them. The label also pins the
 * format: changing the truncation or the grouping means changing the label, so
 * two versions can never be compared as though they were the same thing.
 *
 * Hashed rather than truncated from the DID itself, because every Ed25519
 * `did:key` shares a multicodec prefix - truncating would show the same leading
 * characters for every device.
 *
 * Crockford base32: no I, L, O or U, and case-insensitive, so it survives being
 * read aloud or retyped.
 */

import { base32crockford } from "@scure/base"
import { concat, utf8, type Bytes } from "@/lib/crypto"

/** Domain separation. Bump the suffix if the length or grouping ever changes. */
const FINGERPRINT_LABEL = utf8("synk/device-fingerprint/v1\n")

/**
 * Characters shown. Five bits each, so 16 characters is 80 bits of second
 * preimage resistance. See the note above before changing this.
 */
export const FINGERPRINT_CHARS = 16

/** Bits of second preimage resistance the displayed fingerprint provides. */
export const FINGERPRINT_BITS = FINGERPRINT_CHARS * 5

const GROUP = 4

async function digest(did: string): Promise<Bytes> {
  const input = concat(FINGERPRINT_LABEL, utf8(did))
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input as BufferSource))
}

/**
 * Four groups of four, e.g. `K7QM-3XB9-P2WF-6TDN`.
 *
 * At 80 bits this is a real check rather than a gesture: forging a matching
 * fingerprint is not worth the compute, so a match means the key on the other
 * screen is the key being approved.
 */
export async function deviceFingerprint(did: string): Promise<string> {
  const encoded = base32crockford.encode(await digest(did)).slice(0, FINGERPRINT_CHARS)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += GROUP) groups.push(encoded.slice(i, i + GROUP))
  return groups.join("-")
}

/** Placeholder matching the rendered shape, for inputs that ask for one. */
export const FINGERPRINT_PLACEHOLDER = Array.from({ length: FINGERPRINT_CHARS / GROUP }, () =>
  "X".repeat(GROUP),
).join("-")

/** Compare two fingerprints, tolerant of case and spacing. */
export function fingerprintsMatch(a: string, b: string): boolean {
  const normalise = (value: string) => value.replace(/[\s-]/g, "").toUpperCase()
  const left = normalise(a)
  const right = normalise(b)
  // Length is part of the comparison: a truncated entry must not match a
  // prefix of the real thing.
  return left.length === FINGERPRINT_CHARS && left === right
}
