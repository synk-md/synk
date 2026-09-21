/**
 * `did:key` identifiers: a principal named by its own public key, so a
 * signature can be verified with no registry and no lookup.
 *
 * Ed25519 for signing (`z6Mk...`), X25519 for sealing (`z6LS...`). Parsing is
 * strict on every field because a DID is an identity claim arriving off the
 * network.
 */

import { base58 } from "@scure/base"
import { equalBytes, type Bytes } from "@/lib/crypto"

/** Multicodec prefixes, varint-encoded. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01])
const X25519_MULTICODEC = new Uint8Array([0xec, 0x01])

const DID_KEY_PREFIX = "did:key:"
/** Multibase tag for base58btc. */
const BASE58BTC = "z"

const PUBLIC_KEY_BYTES = 32

export type DidKeyType = "ed25519" | "x25519"

export interface DecodedDid {
  type: DidKeyType
  publicKey: Bytes
}

function encode(prefix: Bytes, publicKey: Bytes): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`public key must be ${PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`)
  }
  const bytes = new Uint8Array(prefix.length + publicKey.length)
  bytes.set(prefix, 0)
  bytes.set(publicKey, prefix.length)
  return DID_KEY_PREFIX + BASE58BTC + base58.encode(bytes)
}

/** `did:key` for an Ed25519 signing key. These render as `did:key:z6Mk...`. */
export function didFromSigningKey(publicKey: Bytes): string {
  return encode(ED25519_MULTICODEC, publicKey)
}

/** `did:key` for an X25519 sealing key. These render as `did:key:z6LS...`. */
export function didFromSealingKey(publicKey: Bytes): string {
  return encode(X25519_MULTICODEC, publicKey)
}

/**
 * Parse a `did:key`, or throw.
 *
 * Strict on every field - prefix, multibase tag, codec, length. A DID is an
 * identity claim that arrives over the network, so a lenient parser here would
 * be a way to smuggle one key in under another's name.
 */
export function decodeDid(did: string): DecodedDid {
  if (!did.startsWith(DID_KEY_PREFIX)) throw new Error("not a did:key identifier")
  const multibase = did.slice(DID_KEY_PREFIX.length)
  if (!multibase.startsWith(BASE58BTC)) {
    throw new Error("did:key must use base58btc (multibase 'z')")
  }

  let bytes: Bytes
  try {
    bytes = base58.decode(multibase.slice(BASE58BTC.length))
  } catch {
    throw new Error("did:key payload is not valid base58btc")
  }

  if (bytes.length !== 2 + PUBLIC_KEY_BYTES) {
    throw new Error(`did:key payload must be ${2 + PUBLIC_KEY_BYTES} bytes, got ${bytes.length}`)
  }

  const prefix = bytes.subarray(0, 2)
  const publicKey = bytes.slice(2)
  if (equalBytes(prefix, ED25519_MULTICODEC)) return { type: "ed25519", publicKey }
  if (equalBytes(prefix, X25519_MULTICODEC)) return { type: "x25519", publicKey }
  throw new Error("did:key uses an unsupported multicodec")
}

/**
 * Public key from a DID that must be of a given type. Use this rather than
 * `decodeDid` wherever the expected type is known: it stops an X25519 key being
 * accepted where a signing key belongs.
 */
export function publicKeyFromDid(did: string, expected: DidKeyType): Bytes {
  const decoded = decodeDid(did)
  if (decoded.type !== expected) {
    throw new Error(`expected a ${expected} did:key, got ${decoded.type}`)
  }
  return decoded.publicKey
}

/** Non-throwing check, for validating untrusted input before branching on it. */
export function isValidDid(did: string, expected?: DidKeyType): boolean {
  try {
    const decoded = decodeDid(did)
    return expected ? decoded.type === expected : true
  } catch {
    return false
  }
}
