/**
 * Enforcement of the device-key-to-client-id binding at the envelope layer.
 *
 * M2 derives the client id a device may use; this is where an update that
 * violates it is rejected. Without this the derivation is decorative - a member
 * could encrypt a Yjs update whose operations carry someone else's client id
 * and have their edits attributed to that person.
 *
 * Only *struct* client ids are checked. A delete set legitimately references
 * the client ids of whoever originally created the deleted items, so a
 * delete-only update carries no structs at all and passes trivially; its
 * authorship still rests on the envelope signature.
 */

import * as Y from "yjs"
import type { Bytes } from "@/lib/crypto"

/** Distinct client ids appearing as struct authors in an update. */
export function updateStructClientIds(update: Bytes): number[] {
  const { structs } = Y.decodeUpdate(update)
  return [...new Set(structs.map((struct) => struct.id.client))]
}

/** Client ids referenced by the delete set - may belong to anyone. */
export function updateDeleteSetClientIds(update: Bytes): number[] {
  return [...Y.decodeUpdate(update).ds.clients.keys()]
}

export interface UpdateAuthorshipResult {
  ok: boolean
  /** Struct client ids that are not the expected author's. */
  foreign: number[]
}

/**
 * Does every operation in this update claim the expected client id?
 *
 * Returns a result rather than throwing: this runs on attacker-supplied bytes
 * and the caller counts the rejection alongside its other drop reasons.
 * Malformed updates are a rejection, not an exception.
 */
export function checkUpdateAuthorship(update: Bytes, clientId: number): UpdateAuthorshipResult {
  let clients: number[]
  try {
    clients = updateStructClientIds(update)
  } catch {
    return { ok: false, foreign: [] }
  }
  const foreign = clients.filter((client) => client !== clientId)
  return { ok: foreign.length === 0, foreign }
}
