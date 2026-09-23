/**
 * The two enforcement points.
 *
 *   write   update acceptance. `CapabilityWritePolicy` replaces the membership
 *           placeholder M4 shipped with, so an envelope from a correctly signed
 *           but unauthorized author is rejected.
 *   read    DEK access. An epoch key is sealed only to principals holding read,
 *           so a non-reader never obtains it.
 *
 * The asymmetry is the interesting part. A write check is *evaluated* on every
 * inbound envelope, so revoking write takes effect as soon as the revocation
 * propagates. A read check is applied when a key is *sealed*, so it governs
 * future epochs rather than past ones - a reader removed today keeps whatever
 * they already hold, and DEK rotation (M5) is what denies them what comes next.
 * Neither check can un-ring a bell.
 */

import type { KeyRecipient } from "@/lib/keys"
import type { WritePolicy } from "@/lib/sync"
import { authorize, type AuthorizationContext, type AuthorizationResult } from "./chain"

/** Resolves the authorization context at the moment of a check. */
export type ContextSource = () => AuthorizationContext | Promise<AuthorizationContext>

/**
 * Update acceptance gated on write.
 *
 * Deliberately re-resolves the context per check rather than caching: a cached
 * context would keep accepting an author whose capability was revoked, which is
 * precisely the case the check exists for.
 */
export class CapabilityWritePolicy implements WritePolicy {
  private readonly context: ContextSource
  /** Set to observe denials - useful for surfacing *why* an edit was refused. */
  readonly onDenied?: (author: string, result: AuthorizationResult) => void

  constructor(context: ContextSource, onDenied?: (author: string, result: AuthorizationResult) => void) {
    this.context = context
    if (onDenied) this.onDenied = onDenied
  }

  async canWrite(resourceId: string, authorDid: string): Promise<boolean> {
    const result = await authorize(
      { principal: authorDid, resource: resourceId, ability: "write" },
      await this.context(),
    )
    if (!result.authorized) this.onDenied?.(authorDid, result)
    return result.authorized
  }
}

/** Convenience for admin-gated operations: issuing grants, cutting epochs. */
export async function canAdminister(
  principal: string,
  resource: string,
  context: AuthorizationContext,
): Promise<boolean> {
  return (await authorize({ principal, resource, ability: "admin" }, context)).authorized
}

export async function canRead(
  principal: string,
  resource: string,
  context: AuthorizationContext,
): Promise<boolean> {
  return (await authorize({ principal, resource, ability: "read" }, context)).authorized
}

/** A key recipient together with the principal whose authority it rests on. */
export interface CandidateReader extends KeyRecipient {
  /** `did:key` of the principal - the audience a read capability names. */
  principal: string
}

export interface ReaderGateResult {
  /** Recipients who hold read. Only these may be sealed to. */
  authorized: CandidateReader[]
  /** Those refused, with the reason, so a caller can explain the difference. */
  denied: { candidate: CandidateReader; result: AuthorizationResult }[]
}

/**
 * DEK access gated on read.
 *
 * Filters a candidate set down to principals who actually hold read on the
 * resource. Sealing paths take the result rather than the raw candidates, so a
 * non-reader is never handed an epoch key.
 */
export async function gateReaders(
  candidates: readonly CandidateReader[],
  resource: string,
  context: AuthorizationContext,
): Promise<ReaderGateResult> {
  const authorized: CandidateReader[] = []
  const denied: { candidate: CandidateReader; result: AuthorizationResult }[] = []

  for (const candidate of candidates) {
    const result = await authorize(
      { principal: candidate.principal, resource, ability: "read" },
      context,
    )
    if (result.authorized) authorized.push(candidate)
    else denied.push({ candidate, result })
  }
  return { authorized, denied }
}

/**
 * Seal only to authorized readers, or refuse the whole operation.
 *
 * `strict` is for the paths where silently sealing to fewer people than asked
 * would be worse than failing - an admin resealing after a removal wants to
 * know their intended recipient list was wrong, not to discover it later when
 * someone cannot read.
 */
export async function requireReaders(
  candidates: readonly CandidateReader[],
  resource: string,
  context: AuthorizationContext,
): Promise<CandidateReader[]> {
  const { authorized, denied } = await gateReaders(candidates, resource, context)
  if (denied.length > 0) {
    const names = denied.map(({ candidate }) => candidate.principal).join(", ")
    throw new Error(`refusing to seal ${resource}: no read capability for ${names}`)
  }
  return authorized
}
