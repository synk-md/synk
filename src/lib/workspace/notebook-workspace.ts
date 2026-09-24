/**
 * A notebook as a workspace: an owner, a directory of member devices, and the
 * scope that capabilities and admissions name.
 *
 * The notebook is the sharing unit in this app, so it is also the trust unit.
 * Everything lives in the notebook's own index document alongside the file
 * tree, which means it syncs by the same path the notebook already syncs by and
 * a peer that has the notebook has its directory.
 *
 * Founding is self-admission and that is not circular: the genesis record says
 * who the owner is, and the owner's admission of their own device verifies
 * against it. What would be circular is trusting an admission to establish the
 * admin who signed it, which is why `readNotebookWorkspace` resolves ownership
 * first and only then reads the directory against that owner.
 */

import * as Y from "yjs"

import {
  putAdmission,
  putDeviceRecord,
  readDirectory,
  type VerifiedDirectory,
} from "@/lib/directory"
import {
  createDeviceAdmission,
  createUser,
  memberOf,
  type DeviceIdentity,
  type MemberDevice,
  type User,
} from "@/lib/identity"

import {
  createGenesis,
  resolveOwnership,
  type Ownership,
  type WorkspaceGenesis,
} from "./genesis"

/** Where genesis claims live, keyed by claimant so a rival cannot overwrite. */
export const GENESIS_MAP = "workspace:genesis"

export function workspaceIdFor(notebookId: string): string {
  return `workspace:${notebookId}`
}

/** What capabilities name. Notes are `notebook:<id>/note:<id>` beneath it. */
export function resourceIdFor(notebookId: string): string {
  return `notebook:${notebookId}`
}

export function memberIdFor(did: string): string {
  return `member:${did.slice(-16)}`
}

export function putGenesis(doc: Y.Doc, genesis: WorkspaceGenesis): void {
  doc.getMap<WorkspaceGenesis>(GENESIS_MAP).set(genesis.owner, genesis)
}

export function genesisClaims(doc: Y.Doc): WorkspaceGenesis[] {
  const claims: WorkspaceGenesis[] = []
  for (const [owner, claim] of doc.getMap<WorkspaceGenesis>(GENESIS_MAP).entries()) {
    // Filed under a DID other than its own is a misfiled or hostile entry; the
    // key is part of what is being asserted.
    if (claim?.owner === owner) claims.push(claim)
  }
  return claims
}

export interface FoundOptions {
  doc: Y.Doc
  notebookId: string
  device: DeviceIdentity
  /** What the owner is called. Admin-attested, because they are the admin. */
  label: string
  createdAt?: number
}

export interface FoundedWorkspace {
  genesis: WorkspaceGenesis
  workspace: string
  resource: string
  member: string
}

/**
 * Found a notebook's workspace. Idempotent: a document that already carries a
 * genesis from this device is left alone, so a second call on an existing
 * notebook does not write a rival claim.
 */
export async function foundNotebookWorkspace(
  options: FoundOptions,
): Promise<FoundedWorkspace> {
  const workspace = workspaceIdFor(options.notebookId)
  const resource = resourceIdFor(options.notebookId)
  const member = memberIdFor(options.device.did)

  const existing = doc0(options.doc).get(options.device.did)
  if (existing) {
    return { genesis: existing, workspace, resource, member }
  }

  const genesis = await createGenesis({
    signingKey: options.device.signingKey,
    owner: options.device.did,
    workspace,
    resource,
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  })

  const admission = await createDeviceAdmission({
    adminSigningKey: options.device.signingKey,
    adminDid: options.device.did,
    record: options.device.record,
    member,
    label: options.label.trim() || "Owner",
    workspace,
    ...(options.createdAt === undefined ? {} : { issuedAt: options.createdAt }),
  })

  // One transaction, so a peer never observes a directory entry whose admin has
  // no genesis behind it.
  options.doc.transact(() => {
    putGenesis(options.doc, genesis)
    putDeviceRecord(options.doc, options.device.record)
    putAdmission(options.doc, admission)
  })

  return { genesis, workspace, resource, member }
}

function doc0(doc: Y.Doc): Y.Map<WorkspaceGenesis> {
  return doc.getMap<WorkspaceGenesis>(GENESIS_MAP)
}

export interface NotebookWorkspace {
  notebookId: string
  workspace: string
  resource: string
  ownership: Ownership
  /** Null until ownership is established - there is no admin set without it. */
  directory: VerifiedDirectory | null
  /** Members, grouped from the verified device set. */
  users: User[]
  /** This device's own entry, when it is in the directory. */
  self: MemberDevice | null
}

export interface ReadWorkspaceOptions {
  doc: Y.Doc
  notebookId: string
  /** This device, so its own membership can be reported. */
  selfDid?: string
  /** Learned from founding it, or from the invitation. See `verifyGenesis`. */
  expectedOwner?: string
  now?: number
}

/**
 * Read the workspace, ownership first.
 *
 * The admin set handed to `readDirectory` is the owner alone. That is the whole
 * point of resolving ownership separately: an admission is only as good as the
 * admin behind it, and taking the admin set from the directory itself would let
 * anyone who can write to the document admit themselves.
 */
export async function readNotebookWorkspace(
  options: ReadWorkspaceOptions,
): Promise<NotebookWorkspace> {
  const workspace = workspaceIdFor(options.notebookId)
  const resource = resourceIdFor(options.notebookId)

  const ownership = await resolveOwnership(genesisClaims(options.doc), {
    workspace,
    resource,
    ...(options.expectedOwner === undefined ? {} : { expectedOwner: options.expectedOwner }),
  })

  const base: NotebookWorkspace = {
    notebookId: options.notebookId,
    workspace,
    resource,
    ownership,
    directory: null,
    users: [],
    self: null,
  }
  if (ownership.owner === null) return base

  const directory = await readDirectory(options.doc, [ownership.owner], {
    workspace,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const byMember = new Map<string, MemberDevice[]>()
  for (const device of directory.devices) {
    const id = memberOf(device)
    const bucket = byMember.get(id)
    if (bucket) bucket.push(device)
    else byMember.set(id, [device])
  }

  return {
    ...base,
    directory,
    users: [...byMember].map(([id, devices]) => createUser(id, devices)),
    self:
      directory.devices.find((device) => device.record.did === options.selfDid) ?? null,
  }
}

/** Admins of this workspace. Today the owner; a grant model arrives with M7's wiring. */
export function adminDids(workspace: NotebookWorkspace): string[] {
  return workspace.ownership.owner ? [workspace.ownership.owner] : []
}
