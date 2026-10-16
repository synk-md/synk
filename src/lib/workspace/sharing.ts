/**
 * Who may edit what: granting, withdrawing and changing access to a notebook
 * or one of its notes.
 *
 * What a grant can mean is set by the keys, not by the grant. Every member
 * holds the notebook's keys, so everyone in it can read every note; a grant
 * on a note can only add editing. And managing access stays with the owner and
 * the owner's own devices, whose admissions are the ones trusted - an admin
 * grant to anyone else would let them cut keys nobody's directory honours.
 */

import type * as Y from "yjs"

import {
  isAuthorized,
  issueCapability,
  revokeCapability,
  type Ability,
  type Capability,
} from "@/lib/authz"
import type { DeviceIdentity } from "@/lib/identity"

import { findOwnerRoot } from "./admission"
import { authorizationContext, linkedPrincipal, putCapability, putRevocation } from "./capabilities"
import { resourceIdFor, workspaceIdFor } from "./notebook-workspace"
import { noteResourceId } from "./note-sync"

export interface SharingOptions {
  doc: Y.Doc
  notebookId: string
  /** The notebook's owner, whose root every grant rests on. */
  owner: string
  /** Signing: the owner, or one of the owner's own devices. */
  device: DeviceIdentity
  now?: number
}

export interface GrantOptions extends SharingOptions {
  audience: string
  resource: string
  ability: Ability
  depth?: number
  expiresAt: number
  /** What it rests on. The owner's root when not said. */
  proof?: Capability | null
}

async function issue(options: GrantOptions): Promise<Capability> {
  if (options.ability === "admin") {
    throw new Error("Managing access stays with the owner and the owner's own devices.")
  }
  const now = options.now ?? Date.now()
  const proof = options.proof ?? (await findOwnerRoot(options.doc, options.owner, resourceIdFor(options.notebookId), now))
  if (!proof) throw new Error("This notebook's owner holds no valid root to share under.")
  return issueCapability({
    signingKey: options.device.signingKey,
    issuer: options.device.did,
    audience: options.audience,
    resource: options.resource,
    ability: options.ability,
    depth: options.depth ?? 0,
    proof: proof.cid,
    notBefore: now,
    expiresAt: Math.min(options.expiresAt, proof.payload.exp),
  })
}

async function withdrawals(options: SharingOptions & { grants: readonly Capability[] }) {
  const out = []
  for (const grant of options.grants) {
    out.push(
      await revokeCapability({
        signingKey: options.device.signingKey,
        issuer: options.device.did,
        capabilityCid: grant.cid,
        revokedAt: options.now ?? Date.now(),
      }),
    )
  }
  return out
}

export async function grantAccess(options: GrantOptions): Promise<Capability> {
  const capability = await issue(options)
  putCapability(options.doc, capability)
  return capability
}

export async function withdrawGrants(options: SharingOptions & { grants: readonly Capability[] }): Promise<void> {
  const revocations = await withdrawals(options)
  options.doc.transact(() => {
    for (const revocation of revocations) putRevocation(options.doc, revocation)
  })
}

/** A new grant at the new level and the old ones withdrawn, in one change, so there is no moment with neither. */
export async function changeAccess(
  options: Omit<GrantOptions, "proof"> & { replacing: readonly Capability[] },
): Promise<Capability> {
  const capability = await issue(options)
  const revocations = await withdrawals({ ...options, grants: options.replacing })
  options.doc.transact(() => {
    putCapability(options.doc, capability)
    for (const revocation of revocations) putRevocation(options.doc, revocation)
  })
  return capability
}

/**
 * Whether this device may edit a note: under its own grant, or - for a device
 * a member linked - under that member's. What peers check; the editor agrees.
 */
export async function mayEditNote(options: {
  doc: Y.Doc
  notebookId: string
  noteId: string
  owner: string
  did: string
  now?: number
}): Promise<boolean> {
  const context = await authorizationContext(options.doc, options.owner, options.now)
  const principal = await linkedPrincipal(options.doc, options.owner, workspaceIdFor(options.notebookId))(options.did)
  return isAuthorized(
    { principal, resource: noteResourceId(options.notebookId, options.noteId), ability: "write" },
    context,
  )
}
