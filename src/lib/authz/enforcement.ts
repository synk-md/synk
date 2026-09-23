/**
 * Two enforcement points: write on update acceptance, read on DEK sealing.
 *
 * The asymmetry matters. A write check runs on every inbound envelope, so it
 * takes effect as the revocation propagates. A read check runs when a key is
 * sealed, so it governs future epochs and not past ones.
 */

import type { KeyRecipient } from "@/lib/keys"
import type { WritePolicy } from "@/lib/sync"
import { authorize, type AuthorizationContext, type AuthorizationResult } from "./chain"

/** Resolves the authorization context at the moment of a check. */
export type ContextSource = () => AuthorizationContext | Promise<AuthorizationContext>

/**
 * Re-resolves the context per check rather than caching: a cached one would
 * keep accepting an author whose capability was revoked.
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

/** Sealing paths take this rather than raw candidates. */
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
 * For paths where sealing to fewer people than asked is worse than failing - an
 * admin resealing wants to know the list was wrong now, not when someone calls.
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
