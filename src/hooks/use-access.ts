"use client"

import * as React from "react"

import type { AuthorizationContext, Capability } from "@/lib/authz"
import {
  grantBudget,
  summarizeAccess,
  type AccessEntry,
  type GrantBudget,
} from "@/components/custom-ui/sharing/access-model"

/**
 * Resolving access is asynchronous - every entry costs signature checks up the
 * chain - so it cannot be done while rendering. These hooks hold the result and
 * re-resolve when the inputs actually change.
 *
 * "Actually" is doing work there. `CapabilityStore.context(now)` builds a fresh
 * object on every call, so a dependency on object identity would re-resolve
 * forever. What matters is which capabilities are in play and what has been
 * revoked, so that is what is compared - a string of cids, cheap beside the
 * signature verification it is guarding.
 *
 * `loading` is exposed rather than defaulting to an empty list: an unresolved
 * access list and an empty one look identical and mean opposite things.
 */

function contextSignature(context: AuthorizationContext): string {
  return [
    context.owner,
    String(context.now),
    [...context.proofs.keys()].sort().join(","),
    [...(context.revoked ?? [])].sort().join(","),
  ].join("|")
}

function capabilitySignature(capabilities: readonly Capability[]): string {
  return capabilities
    .map((capability) => capability.cid)
    .sort()
    .join(",")
}

export interface AccessSummaryState {
  entries: AccessEntry[]
  loading: boolean
}

export function useAccessSummary(
  capabilities: readonly Capability[],
  resource: string,
  context: AuthorizationContext,
): AccessSummaryState {
  const [state, setState] = React.useState<AccessSummaryState>({ entries: [], loading: true })

  // Read through a ref so the effect uses the current values without being
  // retriggered by the objects that carry them.
  const latest = React.useRef({ capabilities, context })
  latest.current = { capabilities, context }

  const key = `${capabilitySignature(capabilities)}::${resource}::${contextSignature(context)}`

  React.useEffect(() => {
    let cancelled = false
    setState((previous) => ({ ...previous, loading: true }))
    const { capabilities: caps, context: ctx } = latest.current
    void summarizeAccess(caps, resource, ctx).then((entries) => {
      if (!cancelled) setState({ entries, loading: false })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return state
}

export interface GrantBudgetState {
  budget: GrantBudget | null
  loading: boolean
}

export function useGrantBudget(
  actor: string,
  resource: string,
  context: AuthorizationContext,
): GrantBudgetState {
  const [state, setState] = React.useState<GrantBudgetState>({ budget: null, loading: true })

  const latest = React.useRef(context)
  latest.current = context

  const key = `${actor}::${resource}::${contextSignature(context)}`

  React.useEffect(() => {
    let cancelled = false
    setState((previous) => ({ ...previous, loading: true }))
    void grantBudget(actor, resource, latest.current).then((budget) => {
      if (!cancelled) setState({ budget, loading: false })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return state
}
