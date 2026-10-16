"use client"

import * as React from "react"

import type { AccessEntry, GrantRequest, Person, RemovalPlan } from "@/components/custom-ui/sharing/access-model"
import type { ShareScope } from "@/components/custom-ui/sharing/share-dialog"
import type { Ability, AuthorizationContext, Capability } from "@/lib/authz"
import { currentDevice, memberOf } from "@/lib/identity"
import {
  authorizationContext,
  changeAccess,
  grantAccess,
  linkedPrincipal,
  noteResourceId,
  readCapabilities,
  readNotebookWorkspace,
  removeFromNotebook,
  resourceIdFor,
  withdrawGrants,
  workspaceIdFor,
} from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

export const SHARING_CEILING: Ability = "write"
export const SHARING_CEILING_REASON = "Managing access stays with the owner and the owner's own devices."

export interface NoteSharing {
  scopes: ShareScope[]
  capabilities: Capability[]
  context: AuthorizationContext
  /** Who this device acts as: itself, or the person who linked it. */
  actor: string
  candidates: Person[]
  people: Person[]
  nameOf: (resource: string) => string
  onGrant: (request: GrantRequest) => Promise<void>
  onRevoke: (entry: AccessEntry, plan: RemovalPlan, scope: ShareScope) => Promise<void>
  onChangeLevel: (entry: AccessEntry, ability: Ability, scope: ShareScope) => Promise<void>
}

/**
 * What the sharing dialog needs for one note: who has access to it and to its
 * notebook, who could be given more, and doing it.
 *
 * Everyone in the notebook reads every note - they hold its keys - so a note
 * offers editing only. Taking someone's notebook access away is removing them
 * from it, keys and all, since a grant withdrawn would leave them reading.
 */
export function useNoteSharing(notebookId: string | null, noteId: string | null, open: boolean): NoteSharing | null {
  const [state, setState] = React.useState<Omit<NoteSharing, "onGrant" | "onRevoke" | "onChangeLevel" | "nameOf" | "scopes"> & {
    owner: string
    members: Map<string, string>
  } | null>(null)

  const notebook = notebookId ? resourceIdFor(notebookId) : null
  const note = notebookId && noteId ? noteResourceId(notebookId, noteId) : null

  React.useEffect(() => {
    const device = currentDevice()
    if (!open || !notebookId || !device) {
      setState(null)
      return
    }
    const { doc } = createNotebookIndexDoc(notebookId)
    let cancelled = false
    const refresh = async () => {
      const self = device.identity.did
      const workspace = await readNotebookWorkspace({ doc, notebookId, selfDid: self })
      const owner = workspace.ownership.owner
      if (!owner || cancelled) return
      const [context, capabilities, actor] = await Promise.all([
        authorizationContext(doc, owner),
        readCapabilities(doc),
        linkedPrincipal(doc, owner, workspaceIdFor(notebookId))(self),
      ])
      const people: Person[] = []
      const members = new Map<string, string>()
      for (const entry of workspace.directory?.devices ?? []) {
        if (entry.kind !== "admitted") continue
        members.set(entry.record.did, memberOf(entry))
        people.push({
          did: entry.record.did,
          label: entry.admission.label,
          assurance: entry.record.did === owner ? "verified" : "invited",
        })
      }
      if (cancelled) return
      setState({
        capabilities,
        context,
        actor,
        people,
        candidates: people.filter((person) => person.did !== owner),
        owner,
        members,
      })
    }
    const schedule = () => {
      void refresh().catch((error: unknown) => {
        console.warn("sharing", error)
      })
    }
    doc.on("update", schedule)
    schedule()
    return () => {
      cancelled = true
      doc.off("update", schedule)
    }
  }, [open, notebookId])

  // The note first when there is one: the narrowest scope is the default.
  const scopes = React.useMemo<ShareScope[]>(() => {
    if (!notebook) return []
    const whole: ShareScope = {
      resource: notebook,
      label: "the whole notebook",
      covers: "Every note in it, and any added later.",
    }
    if (!note) return [whole]
    return [
      {
        resource: note,
        label: "this note",
        covers: "Editing this note. Everyone in the notebook can already read every note in it.",
        min: "write",
        minReason: "Everyone in the notebook can already read this note, so access here can only add editing.",
      },
      whole,
    ]
  }, [notebook, note])

  const nameOf = React.useCallback(
    (resource: string) => (resource === notebook ? "the whole notebook" : resource === note ? "this note" : resource),
    [notebook, note],
  )

  if (!state || !notebookId || scopes.length === 0) return null
  const device = currentDevice()
  if (!device) return null
  const { doc } = createNotebookIndexDoc(notebookId)
  const base = { doc, notebookId, owner: state.owner, device: device.identity }

  const removeEntirely = async (principal: string) => {
    const member = state.members.get(principal)
    if (!member) throw new Error("They are not a member of this notebook.")
    await removeFromNotebook({ doc, notebookId, owner: device.identity, ownerDid: state.owner, member })
  }

  return {
    scopes,
    capabilities: state.capabilities,
    context: state.context,
    actor: state.actor,
    candidates: state.candidates,
    people: state.people,
    nameOf,
    onGrant: async (request) => {
      await grantAccess({
        ...base,
        audience: request.audience,
        resource: request.resource,
        ability: request.ability,
        depth: request.depth,
        expiresAt: request.expiresAt,
        proof: request.proof,
      })
    },
    onRevoke: async (entry, plan, scope) => {
      // Access through the notebook cannot be taken from one note: grants only
      // add. Taking it at all is removing them, keys and all.
      if (scope.resource === notebook || plan.wider.length > 0) return removeEntirely(entry.principal)
      await withdrawGrants({ ...base, grants: plan.revoke.filter((grant) => grant.payload.rsc === scope.resource) })
    },
    onChangeLevel: async (entry, ability, scope) => {
      await changeAccess({
        ...base,
        audience: entry.principal,
        resource: scope.resource,
        ability,
        expiresAt: entry.expiresAt,
        replacing: entry.grants.filter((grant) => grant.direct).map((grant) => grant.capability),
      })
    },
  }
}
