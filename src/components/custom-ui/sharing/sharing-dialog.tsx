"use client"

import * as React from "react"
import { RiCloseLine, RiUserAddLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"

import { AccessList } from "./access-list"
import type { AccessEntry, GrantRequest, Person, RemovalPlan } from "./access-model"
import { ShareDialog, type ShareScope } from "./share-dialog"

import "./sharing.scss"

export type SharingDialogProps = {
  open: boolean
  onClose: () => void
  /** Narrowest first. A note and its notebook, or just the notebook. */
  scopes: readonly ShareScope[]
  capabilities: readonly Capability[]
  context: AuthorizationContext
  actor: string
  candidates: readonly Person[]
  people?: readonly Person[]
  onGrant: (request: GrantRequest) => Promise<void> | void
  onRevoke?: (entry: AccessEntry, plan: RemovalPlan) => Promise<void> | void
  onChangeLevel?: (entry: AccessEntry, ability: Ability) => Promise<void> | void
  className?: string
}

/**
 * Sharing, as one screen.
 *
 * Who has access comes first and sharing comes second, in that order and not
 * behind a tab. The question "who can already see this" is the one that decides
 * whether to share at all and at what level, and a tab is a good way to make
 * sure it is never asked. The cost is a taller dialog, which is cheap.
 *
 * The scope switch changes what both halves are about, so the list and the
 * grant can never disagree about which resource is being discussed.
 */
export function SharingDialog({
  open,
  onClose,
  scopes,
  capabilities,
  context,
  actor,
  candidates,
  people,
  onGrant,
  onRevoke,
  onChangeLevel,
  className,
}: SharingDialogProps) {
  const [scopeIndex, setScopeIndex] = React.useState(0)
  const [sharing, setSharing] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setScopeIndex(0)
      setSharing(false)
    }
  }, [open])

  React.useEffect(() => {
    if (!open || sharing) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, sharing, onClose])

  if (!open) return null

  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)]
  // Sharing is always offered from the narrowest scope up, whichever the list is
  // showing, so the safe option stays the default even when someone has
  // switched the view to the notebook.
  const shareScopes = scopes.slice(scopeIndex)

  return (
    <>
      <div
        className="shr-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div
          className={["shr-dialog", className ?? ""].join(" ")}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sharing-heading"
        >
          <div className="shr-header">
            <div className="shr-heading">
              <h3 id="sharing-heading">Access to {scope.label}</h3>
            </div>
            <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
              <RiCloseLine className="tiptap-button-icon" />
            </Button>
          </div>

          {scopes.length > 1 && (
            <div className="shr-tabs" role="tablist" aria-label="Scope">
              {scopes.map((option, index) => (
                <button
                  key={option.resource}
                  type="button"
                  role="tab"
                  aria-selected={scopeIndex === index}
                  className={["shr-tab", scopeIndex === index ? "is-selected" : ""].join(" ")}
                  onClick={() => setScopeIndex(index)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          <p className="shr-hint">{scope.covers}</p>

          <AccessList
            capabilities={capabilities}
            resource={scope.resource}
            resourceLabel={scope.label}
            context={context}
            actor={actor}
            people={people ?? candidates}
            {...(onRevoke ? { onRevoke } : {})}
            {...(onChangeLevel ? { onChangeLevel } : {})}
          />

          <div className="shr-actions">
            <Button className="shr-primary-btn is-active" onClick={() => setSharing(true)}>
              <RiUserAddLine className="tiptap-button-icon" />
              <span className="tiptap-button-text">Share {scope.label}</span>
            </Button>
          </div>
        </div>
      </div>

      <ShareDialog
        open={sharing}
        onClose={() => setSharing(false)}
        scopes={shareScopes}
        candidates={candidates}
        capabilities={capabilities}
        context={context}
        actor={actor}
        onGrant={onGrant}
      />
    </>
  )
}

export default SharingDialog
