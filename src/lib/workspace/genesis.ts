/**
 * Who owns a resource, as a signed record rather than a constructor argument.
 *
 * The capability chain bottoms out at "a root is only a root if the owner
 * issued it", and until now the owner was simply supplied. This is the record
 * that says so: self-signed by the founding device at creation.
 *
 * What it does **not** do is make ownership self-proving. Anyone can sign a
 * genesis for any id - the signature says who wrote it, not that they were
 * first. It is authoritative only when the owner is already known from
 * somewhere else: you founded it yourself, or an invitation named the admin and
 * you check the genesis matches. `verifyGenesis` takes that expectation, and a
 * caller that passes none is doing trust-on-first-use and should know it.
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

import type { Lineage } from "./succession"

export const GENESIS_VERSION = 1

export interface WorkspaceGenesisBody {
  v: typeof GENESIS_VERSION
  /** Workspace scope, as admissions and invitations name it. */
  workspace: string
  /** The resource the workspace governs, as capabilities name it. */
  resource: string
  /** `did:key` of the founding device. The owner every chain must reach. */
  owner: string
  /**
   * The recovery code's signing key, and the sealing key every key segment is
   * also sealed to. Fixed here, at founding, so a stolen owner device cannot
   * swap in a code of its own.
   */
  recovery?: string
  recoverySealing?: string
  createdAt: number
}

export interface WorkspaceGenesis extends WorkspaceGenesisBody {
  sig: string
}

export function genesisBytes(body: WorkspaceGenesisBody): Bytes {
  return utf8(
    [
      "synk/workspace-genesis/v1",
      String(body.v),
      body.workspace,
      body.resource,
      body.owner,
      String(body.createdAt),
      // Only when present, so a genesis from before verifies unchanged.
      ...(body.recovery === undefined ? [] : [body.recovery, body.recoverySealing ?? ""]),
    ].join("\n"),
  )
}

export async function createGenesis(options: {
  signingKey: SigningKey
  owner: string
  workspace: string
  resource: string
  recovery?: { did: string; sealingDid: string }
  createdAt?: number
}): Promise<WorkspaceGenesis> {
  const ownerKey = publicKeyFromDid(options.owner, "ed25519")
  if (toBase64Url(ownerKey) !== toBase64Url(options.signingKey.publicKey)) {
    throw new Error("owner does not match the supplied signing key")
  }
  const body: WorkspaceGenesisBody = {
    v: GENESIS_VERSION,
    workspace: options.workspace,
    resource: options.resource,
    owner: options.owner,
    ...(options.recovery ? { recovery: options.recovery.did, recoverySealing: options.recovery.sealingDid } : {}),
    createdAt: options.createdAt ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(genesisBytes(body))) }
}

export interface VerifyGenesisOptions {
  workspace?: string
  resource?: string
  /**
   * The owner learned elsewhere - from founding it, or from the invitation that
   * brought you here. Without it this check establishes authorship only.
   */
  expectedOwner?: string
}

export async function verifyGenesis(
  genesis: WorkspaceGenesis,
  options: VerifyGenesisOptions = {},
): Promise<boolean> {
  try {
    if (genesis.v !== GENESIS_VERSION) return false
    if (options.workspace !== undefined && genesis.workspace !== options.workspace) return false
    if (options.resource !== undefined && genesis.resource !== options.resource) return false
    if (options.expectedOwner !== undefined && genesis.owner !== options.expectedOwner) return false

    const { sig, ...body } = genesis
    return await verifySignature(
      publicKeyFromDid(genesis.owner, "ed25519"),
      genesisBytes(body),
      fromBase64Url(sig),
    )
  } catch {
    return false
  }
}

export type OwnershipStatus =
  /** Exactly one genesis verified. Normal. */
  | "established"
  /** None present, or none verified. */
  | "none"
  /** More than one verified genesis. Someone is asserting a rival ownership. */
  | "disputed"

export interface Ownership {
  status: OwnershipStatus
  /** The owner now: the genesis owner, or whoever took over since. */
  owner: string | null
  genesis: WorkspaceGenesis | null
  /** Every verified claim, when they disagree. Surfaced, never resolved here. */
  claims: WorkspaceGenesis[]
  /** Every owner from the genesis on, and the recovery code that stands now. */
  lineage?: Lineage
}

/**
 * Resolve ownership from every claim in the document.
 *
 * A merged Yjs document can carry a rival genesis written by any peer, so more
 * than one verifying claim is possible and picking a winner would be inventing
 * an answer. With an expected owner the rivals simply fail to verify; without
 * one, the disagreement is reported.
 */
export async function resolveOwnership(
  claims: readonly WorkspaceGenesis[],
  options: VerifyGenesisOptions = {},
): Promise<Ownership> {
  const verified: WorkspaceGenesis[] = []
  for (const claim of claims) {
    if (await verifyGenesis(claim, options)) verified.push(claim)
  }

  if (verified.length === 0) return { status: "none", owner: null, genesis: null, claims: [] }
  // Several claims by one owner are one claim; a rival is a different owner.
  if (new Set(verified.map((claim) => claim.owner)).size > 1) {
    return { status: "disputed", owner: null, genesis: null, claims: verified }
  }
  return {
    status: "established",
    owner: verified[0].owner,
    genesis: verified[0],
    claims: verified,
  }
}
