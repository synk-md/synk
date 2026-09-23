/**
 * A short, human-comparable fingerprint of a device key, for checking that the
 * key on screen is the key on the device in front of you.
 *
 * **The displayed length is a security parameter, not a layout choice.** The
 * attack is an offline second preimage on the truncated digest - one keygen
 * plus one SHA-256 per try - so 16 characters is 80 bits and shortening it to
 * fit a design is a security change.
 *
 * Domain-separated, so a grind against one use is not a grind against all of
 * them, and so the label pins the format. Hashed rather than truncated from the
 * DID, which shares a multicodec prefix across every device. Crockford base32
 * survives being read aloud.
 */

import { base32crockford } from "@scure/base"
import { concat, utf8, type Bytes } from "@/lib/crypto"

/** Domain separation. Bump the suffix if the length or grouping ever changes. */
const FINGERPRINT_LABEL = utf8("synk/device-fingerprint/v1\n")

/** Five bits each, so 16 characters is 80 bits. See the note above. */
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
