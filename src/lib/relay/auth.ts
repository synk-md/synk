/**
 * Authenticating a device to the relay, for billing and rate limiting only.
 * Authorization is decided by the capability chain, on the client.
 *
 * Challenge-response over the device key, so nothing bearer-shaped is stored.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

export const AUTH_VERSION = 1

/** Bound to the relay id, so a challenge cannot be replayed at another relay. */
export function challengeBytes(relayId: string, challenge: string): Uint8Array {
  return utf8(["synk/relay-auth/v1", String(AUTH_VERSION), relayId, challenge].join("\n"))
}

export function newChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)))
}

export async function signChallenge(
  signingKey: SigningKey,
  relayId: string,
  challenge: string,
): Promise<string> {
  return toBase64Url(await signingKey.sign(challengeBytes(relayId, challenge)))
}

export async function verifyChallenge(
  did: string,
  relayId: string,
  challenge: string,
  sig: string,
): Promise<boolean> {
  try {
    return await verifySignature(
      publicKeyFromDid(did, "ed25519"),
      challengeBytes(relayId, challenge),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}
