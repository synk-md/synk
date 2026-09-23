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
 * Resolving access costs signature checks, so it cannot happen while rendering.
 *
 * Keyed on a signature of cids rather than object identity, because
 * `CapabilityStore.context(now)` returns a fresh object every call and would
 * otherwise re-resolve forever.
 *
 * `loading` is exposed because an unresolved list and an empty one look
 * identical and mean opposite things.
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

  // Current values without being retriggered by the objects carrying them.
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
