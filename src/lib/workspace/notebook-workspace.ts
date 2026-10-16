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
  slotFor,
  valuesIn,
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

import { pinnedOwner, pinOwner } from "./owner-pins"
import { resolveLineage, standbysIn, successionsIn } from "./succession"
import { createGenesis, verifyGenesis, type Ownership, type WorkspaceGenesis } from "./genesis"

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

/** In a slot of its own, so a rival's claim can sit beside it but never replace it. */
export function putGenesis(doc: Y.Doc, genesis: WorkspaceGenesis): void {
  doc.getMap<WorkspaceGenesis>(GENESIS_MAP).set(slotFor(genesis.owner, genesis.sig), genesis)
}

export function genesisClaims(doc: Y.Doc): WorkspaceGenesis[] {
  const claims = new Map<string, WorkspaceGenesis>()
  for (const claim of valuesIn<WorkspaceGenesis>(doc, GENESIS_MAP)) {
    if (typeof claim.owner === "string" && typeof claim.sig === "string") claims.set(claim.sig, claim)
  }
  return [...claims.values()]
}

export interface FoundOptions {
  doc: Y.Doc
  notebookId: string
  device: DeviceIdentity
  /** What the owner is called. Admin-attested, because they are the admin. */
  label: string
  /** The recovery code's public keys, fixed in the genesis. */
  recovery?: { did: string; sealingDid: string }
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

  const existing = genesisClaims(options.doc).find((claim) => claim.owner === options.device.did)
  if (existing) {
    return { genesis: existing, workspace, resource, member }
  }

  const genesis = await createGenesis({
    signingKey: options.device.signingKey,
    owner: options.device.did,
    workspace,
    resource,
    ...(options.recovery ? { recovery: options.recovery } : {}),
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

  const ownership = await resolveNotebookOwnership(options.doc, {
    notebookId: options.notebookId,
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

/**
 * Who owns the notebook now. The genesis says who founded it; its lineage
 * says who has taken over since. A device remembers the founder - the root the
 * lineage is followed from - so a rival genesis fails, and an expected owner,
 * from an invitation, may be anyone in that lineage.
 */
export async function resolveNotebookOwnership(
  doc: Y.Doc,
  options: { notebookId: string; workspace: string; resource: string; expectedOwner?: string },
): Promise<Ownership> {
  const expected = [options.expectedOwner, pinnedOwner(options.notebookId) ?? undefined].filter(
    (did): did is string => did !== undefined,
  )
  const roots = new Map<string, WorkspaceGenesis>()
  for (const claim of genesisClaims(doc)) {
    if (roots.has(claim.owner)) continue
    if (await verifyGenesis(claim, { workspace: options.workspace, resource: options.resource })) roots.set(claim.owner, claim)
  }
  const standbys = standbysIn(doc)
  const successions = successionsIn(doc)
  const candidates = []
  for (const genesis of roots.values()) {
    const lineage = await resolveLineage(genesis, standbys, successions)
    if (expected.every((did) => did === genesis.owner || lineage.owners.includes(did))) candidates.push({ genesis, lineage })
  }

  if (candidates.length === 0) return { status: "none", owner: null, genesis: null, claims: [] }
  if (candidates.length > 1) {
    return { status: "disputed", owner: null, genesis: null, claims: candidates.map((each) => each.genesis) }
  }
  const [{ genesis, lineage }] = candidates
  pinOwner(options.notebookId, genesis.owner)
  if (lineage.status === "disputed") return { status: "disputed", owner: null, genesis, claims: [genesis], lineage }
  return { status: "established", owner: lineage.owner, genesis, claims: [genesis], lineage }
}

/**
 * Where a new key segment is also sealed: the recovery code that stands now,
 * so whoever holds it can read the notebook when every device is gone.
 */
export async function recoveryRecipients(doc: Y.Doc, notebookId: string): Promise<{ sealingDid: string }[]> {
  const ownership = await resolveNotebookOwnership(doc, {
    notebookId,
    workspace: workspaceIdFor(notebookId),
    resource: resourceIdFor(notebookId),
  })
  const recovery = ownership.lineage?.recovery
  return recovery ? [{ sealingDid: recovery.sealingDid }] : []
}

/** Admins of this workspace: the owner and the owner's own linked devices. */
export function adminDids(workspace: NotebookWorkspace): string[] {
  if (!workspace.ownership.owner) return []
  return workspace.directory?.admins ?? [workspace.ownership.owner]
}
