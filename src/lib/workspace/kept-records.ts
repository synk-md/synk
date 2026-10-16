/**
 * Everything some devices signed with an admin's authority, by signature or
 * capability id - what an admin keeps when one of them stops being an admin:
 * an unlinked deputy, or an owner someone took over from.
 */

import type * as Y from "yjs"

import type { Revocation } from "@/lib/authz"
import { DIRECTORY_MAPS, valuesIn } from "@/lib/directory"

import { readCapabilities, REVOCATION_MAP } from "./capabilities"
import { keyDomainFor, storedEpochRecords } from "./notebook-keys"

export async function signedBy(doc: Y.Doc, notebookId: string, dids: readonly string[]): Promise<string[]> {
  const signers = new Set(dids)
  const out: string[] = []
  for (const name of [
    DIRECTORY_MAPS.admissions,
    DIRECTORY_MAPS.removals,
    DIRECTORY_MAPS.invitations,
    DIRECTORY_MAPS.invitationRevocations,
    DIRECTORY_MAPS.ratifications,
  ]) {
    for (const record of valuesIn<{ admin?: string; sig?: string }>(doc, name)) {
      if (record.admin && signers.has(record.admin) && typeof record.sig === "string") out.push(record.sig)
    }
  }
  for (const signed of storedEpochRecords(doc, keyDomainFor(notebookId))) {
    if (signers.has(signed.asserter)) out.push(signed.sig)
  }
  for (const capability of await readCapabilities(doc)) {
    if (signers.has(capability.payload.iss)) out.push(capability.cid)
  }
  for (const revocation of valuesIn<Revocation>(doc, REVOCATION_MAP)) {
    if (signers.has(revocation.iss) && typeof revocation.sig === "string") out.push(revocation.sig)
  }
  return out
}
