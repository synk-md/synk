/**
 * Collected capabilities and revocations, resolved into a verification context.
 * Not a persistence layer.
 *
 * A revocation is honoured only after it is checked against the chain it claims
 * to withdraw, so a stranger cannot revoke a grant by asserting it.
 */

import type { Capability } from "./capability"
import { decodeCapability, verifyCapabilitySignature } from "./capability"
import { verifyChain, type AuthorizationContext } from "./chain"
import { chainIssuers, verifyRevocation, type Revocation } from "./revocation"

export class CapabilityStore {
  readonly owner: string
  private readonly capabilities = new Map<string, Capability>()
  private readonly revocations = new Map<string, Revocation>()
  private readonly deputies: ReadonlyMap<string, string>
  private readonly kept: ReadonlySet<string>

  constructor(
    owner: string,
    options: { deputies?: ReadonlyMap<string, string>; kept?: ReadonlySet<string> } = {},
  ) {
    this.owner = owner
    this.deputies = options.deputies ?? new Map()
    this.kept = options.kept ?? new Set()
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
   * Entitlement is judged against the capability's own chain, so that is
   * resolved first: with proofs missing there is no way to know who was entitled.
   */
  async revoke(revocation: Revocation, now: number): Promise<boolean> {
    const capability = this.capabilities.get(revocation.cid)
    if (!capability) return false

    const walked = await verifyChain(capability, this.context(now))
    const issuers = chainIssuers(walked.chain ?? [capability])
    // A deputy revokes as the principal it acts for; a kept revocation, as the owner.
    const principal =
      this.deputies.get(revocation.iss) ?? (this.kept.has(revocation.sig) ? this.owner : revocation.iss)
    const entitled = principal === this.owner || issuers.includes(principal)
    const judged = entitled ? [...issuers, revocation.iss] : issuers
    if (!(await verifyRevocation(revocation, capability, judged, this.owner))) return false

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
      deputies: this.deputies,
      kept: this.kept,
    }
  }

  get size(): number {
    return this.capabilities.size
  }
}
