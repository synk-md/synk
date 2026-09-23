/**
 * A standalone signed delegation, UCAN 1.0-aligned, carrying a pointer to the
 * proof it rests on so a chain walks back to the owner with no converged
 * authority structure anywhere.
 *
 * `aud` is a bare `did:key` and the verifier never asks what kind of principal
 * it names - a device today, a group key later, with no change here.
 *
 * Encoded JWT-compact, so a token survives a relay, a URL and a copy-paste.
 */

import {
  fromBase64Url,
  toBase64Url,
  utf8,
  verifySignature,
  type Bytes,
  type SigningKey,
} from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

export const CAPABILITY_VERSION = "1.0.0-synk"

/** Ordered by strength: admin implies write implies read. */
export type Ability = "read" | "write" | "admin"

export interface CapabilityHeader {
  alg: "EdDSA"
  typ: "JWT"
  ucv: typeof CAPABILITY_VERSION
}

export interface CapabilityPayload {
  /** `did:key` of the issuer. Must equal the parent's audience, or be the owner. */
  iss: string
  /** `did:key` of the audience. Opaque - a device today, a group later. */
  aud: string
  /** Typed resource, e.g. `notebook:1` or `notebook:1/note:abc`. */
  rsc: string
  can: Ability
  /** Re-delegations this audience may make. Zero is a non-delegable leaf. */
  dep: number
  /** Pointer to the proof this rests on: the parent's `cid`. Null at a root. */
  prf: string | null
  /** Not before, epoch ms. */
  nbf: number
  /** Expires at, epoch ms. */
  exp: number
  /** Uniqueness, so two otherwise identical grants get distinct ids. */
  nnc: string
}

export interface Capability {
  header: CapabilityHeader
  payload: CapabilityPayload
  /** The JWT-compact form. Canonical: everything else is derived from it. */
  token: string
  /** SHA-256 of the token, base64url. What `prf` points at. */
  cid: string
}

function segment(value: unknown): string {
  return toBase64Url(utf8(JSON.stringify(value)))
}

async function sha256(bytes: Bytes): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))
}

export function capabilityCid(token: string): Promise<string> {
  return sha256(utf8(token))
}

export interface IssueCapabilityOptions {
  signingKey: SigningKey
  /** Must match `signingKey`, or the token would name an issuer that did not sign. */
  issuer: string
  audience: string
  resource: string
  ability: Ability
  /** Defaults to 0 - a non-delegable leaf. */
  depth?: number
  /** The parent's cid. Omit for a root, which only the resource owner may issue. */
  proof?: string | null
  notBefore?: number
  expiresAt: number
  nonce?: string
}

export async function issueCapability(
  options: IssueCapabilityOptions,
): Promise<Capability> {
  const issuerKey = publicKeyFromDid(options.issuer, "ed25519")
  if (toBase64Url(issuerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("issuer does not match the supplied signing key")
  }
  publicKeyFromDid(options.audience, "ed25519")

  const depth = options.depth ?? 0
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error("capability depth must be a non-negative integer")
  }
  const notBefore = options.notBefore ?? Date.now()
  if (options.expiresAt <= notBefore) {
    throw new Error("capability expiry must be after its start")
  }

  const header: CapabilityHeader = { alg: "EdDSA", typ: "JWT", ucv: CAPABILITY_VERSION }
  const payload: CapabilityPayload = {
    iss: options.issuer,
    aud: options.audience,
    rsc: options.resource,
    can: options.ability,
    dep: depth,
    prf: options.proof ?? null,
    nbf: notBefore,
    exp: options.expiresAt,
    nnc: options.nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(9))),
  }

  const signingInput = `${segment(header)}.${segment(payload)}`
  const signature = toBase64Url(await options.signingKey.sign(utf8(signingInput)))
  const token = `${signingInput}.${signature}`
  return { header, payload, token, cid: await capabilityCid(token) }
}

/** Parse a JWT-compact token. Throws on anything malformed. */
export async function decodeCapability(token: string): Promise<Capability> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("capability token must have three segments")

  let header: CapabilityHeader
  let payload: CapabilityPayload
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as CapabilityHeader
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as CapabilityPayload
  } catch {
    throw new Error("capability segments are not valid base64url JSON")
  }

  if (header?.alg !== "EdDSA" || header.typ !== "JWT") {
    throw new Error("unsupported capability header")
  }
  if (header.ucv !== CAPABILITY_VERSION) {
    throw new Error(`unsupported capability version ${String(header.ucv)}`)
  }
  if (!isPayloadShaped(payload)) throw new Error("capability payload is malformed")

  return { header, payload, token, cid: await capabilityCid(token) }
}

function isPayloadShaped(payload: CapabilityPayload): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.iss === "string" &&
    typeof payload.aud === "string" &&
    typeof payload.rsc === "string" &&
    (payload.can === "read" || payload.can === "write" || payload.can === "admin") &&
    Number.isInteger(payload.dep) &&
    payload.dep >= 0 &&
    (payload.prf === null || typeof payload.prf === "string") &&
    Number.isFinite(payload.nbf) &&
    Number.isFinite(payload.exp) &&
    typeof payload.nnc === "string"
  )
}

/**
 * The token is canonical; `payload` is a view of it. The chain walk reads
 * `payload` while the signature covers `token`, so a divergence would be a
 * privilege escalation. Compared, never assumed equal.
 */
function payloadMatchesToken(capability: Capability, encodedPayload: string): boolean {
  let signed: CapabilityPayload
  try {
    signed = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encodedPayload)),
    ) as CapabilityPayload
  } catch {
    return false
  }
  const claimed = capability.payload
  return (
    signed.iss === claimed.iss &&
    signed.aud === claimed.aud &&
    signed.rsc === claimed.rsc &&
    signed.can === claimed.can &&
    signed.dep === claimed.dep &&
    signed.prf === claimed.prf &&
    signed.nbf === claimed.nbf &&
    signed.exp === claimed.exp &&
    signed.nnc === claimed.nnc
  )
}

/**
 * Signature plus payload/token agreement. Says nothing about whether the issuer
 * had the authority to grant this - that is the chain walk's job.
 */
export async function verifyCapabilitySignature(capability: Capability): Promise<boolean> {
  try {
    const parts = capability.token.split(".")
    if (parts.length !== 3) return false
    if (!payloadMatchesToken(capability, parts[1])) return false
    const issuerKey = publicKeyFromDid(capability.payload.iss, "ed25519")
    return await verifySignature(
      issuerKey,
      utf8(`${parts[0]}.${parts[1]}`),
      fromBase64Url(parts[2]),
    )
  } catch {
    return false
  }
}

export function isTimeValid(payload: CapabilityPayload, now: number): boolean {
  return now >= payload.nbf && now < payload.exp
}
