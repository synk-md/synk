/**
 * Derives the Yjs client id a device is permitted to use, from its signing key:
 *
 *     clientId = top53bits(SHA-256("synk/client-id/v1" ‖ signingPublicKey))
 *
 * Derived rather than stored so any peer can recompute it offline and no member
 * can author operations under another device's id. This is the
 * attribution-integrity invariant.
 *
 * A stable id obliges the per-document Yjs clock never to rewind; see
 * `clock-durability.ts`.
 */

import { concat, utf8, type Bytes } from "@/lib/crypto"

const CLIENT_ID_LABEL = utf8("synk/client-id/v1")

/** Widest value that survives lib0's var-uint round trip exactly. */
export const MAX_CLIENT_ID = Number.MAX_SAFE_INTEGER

/** The one client id this signing key is permitted to use. */
export async function deriveClientId(signingPublicKey: Bytes): Promise<number> {
  if (signingPublicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${signingPublicKey.length}`)
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat(CLIENT_ID_LABEL, signingPublicKey)),
  )
  // Take the top 53 bits of the digest. Done in BigInt rather than with shifts
  // because JavaScript's bitwise operators coerce to int32, which would quietly
  // throw away every bit above the 32nd - the exact bug this widening exists to
  // avoid. The result is always <= MAX_SAFE_INTEGER, so `Number` is exact.
  const view = new DataView(digest.buffer, digest.byteOffset, 8)
  return Number(view.getBigUint64(0) >> 11n)
}

/**
 * Does this client id belong to this device key? The check every inbound
 * envelope performs before its operations are attributed to an author.
 */
export async function clientIdMatchesDevice(
  clientId: number,
  signingPublicKey: Bytes,
): Promise<boolean> {
  return clientId === (await deriveClientId(signingPublicKey))
}

/**
 * Pin a Yjs document to the client id its device key permits.
 *
 * Yjs assigns a random `clientID` in the constructor, so this must run before
 * the document authors anything - operations already written under the random
 * id would keep it and become unattributable.
 */
export async function bindDocumentClientId(
  doc: { clientID: number },
  signingPublicKey: Bytes,
): Promise<number> {
  const clientId = await deriveClientId(signingPublicKey)
  doc.clientID = clientId
  return clientId
}

/**
 * Detect the 1-in-10^8 case before it corrupts a document.
 *
 * Throws rather than returning a flag: there is no sensible way to continue,
 * and silently proceeding means two devices writing as one logical actor.
 */
export function assertNoClientIdCollision(clientIds: readonly number[]): void {
  const seen = new Set<number>()
  for (const id of clientIds) {
    if (seen.has(id)) {
      throw new Error(
        `client id collision on ${id}: two device keys derive the same Yjs client id. ` +
          `The later device must regenerate its signing key.`,
      )
    }
    seen.add(id)
  }
}
