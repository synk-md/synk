/**
 * A collection of capabilities and revocations, resolved into a verification
 * context.
 *
 * Not a persistence layer. It holds what has been collected - from the
 * directory, from a peer, from an invitation - and answers proof lookups by
 * cid. Where the tokens actually live is M8's.
 *
 * Revocations are only honoured once they have been checked against the chain
 * they claim to withdraw, so a stranger cannot revoke a grant by asserting it.
 */

import type { Capability } from "./capability"
import { decodeCapability, verifyCapabilitySignature } from "./capability"
import { verifyChain, type AuthorizationContext } from "./chain"
import { chainIssuers, verifyRevocation, type Revocation } from "./revocation"

export class CapabilityStore {
  readonly owner: string
  private readonly capabilities = new Map<string, Capability>()
  private readonly revocations = new Map<string, Revocation>()

  constructor(owner: string) {
    this.owner = owner
  }

  /** Add a capability. Signature is checked; authority is not - that is the walk's job. */
  async add(capability: Capability): Promise<boolean> {
    if (!(await verifyCapabilitySignature(capability))) return false
    this.capabilities.set(capability.cid, capability)
    return true
  }

  async addToken(token: string): Promise<Capability | undefined> {
    try {
      const capability = await decodeCapability(token)
      return (await this.add(capability)) ? capability : undefined
    } catch {
      return undefined
    }
  }

  get(cid: string): Capability | undefined {
    return this.capabilities.get(cid)
  }

  all(): Capability[] {
    return [...this.capabilities.values()]
  }

  /**
   * Record a revocation, if its issuer is entitled to make it.
   *
   * Entitlement is judged against the capability's own chain, so this resolves
   * that chain first - a revocation for a capability whose proofs are missing
   * is not honoured, because there is no way to know who was entitled.
   */
  async revoke(revocation: Revocation, now: number): Promise<boolean> {
    const capability = this.capabilities.get(revocation.cid)
    if (!capability) return false

    const walked = await verifyChain(capability, this.context(now))
    const issuers = chainIssuers(walked.chain ?? [capability])
    if (!(await verifyRevocation(revocation, capability, issuers, this.owner))) return false

    this.revocations.set(revocation.cid, revocation)
    return true
  }

  revokedCids(): Set<string> {
    return new Set(this.revocations.keys())
  }

  isRevoked(cid: string): boolean {
    return this.revocations.has(cid)
  }

  /** The context a check runs against, as of `now`. */
  context(now: number): AuthorizationContext {
    return {
      proofs: this.capabilities,
      owner: this.owner,
      now,
      revoked: this.revokedCids(),
    }
  }

  get size(): number {
    return this.capabilities.size
  }
}
