/**
 * Pairing a new device with one you already use.
 *
 * The two meet in a channel at the relay derived from a one-time secret: the
 * new device posts its signed record, the existing one links it into every
 * notebook it can and posts back which. Neither needs the other online at the
 * moment it acts.
 *
 * The secret only gets a device into the channel. What admits it is the person
 * comparing the new device's code with what their own screen shows, exactly as
 * an owner does when letting someone in - so a pairing link that leaks lets
 * nobody in on its own. Anything in the channel is unsigned and treated as a
 * claim: a forged approval names notebooks the device holds no keys to.
 */

import type * as Y from "yjs"

import { deriveKey, toBase64Url, type Bytes } from "@/lib/crypto"
import type { DeviceRecord } from "@/lib/identity"

import type { DirectoryChannel } from "./replicas"

const PAIRING_MAP = "pairing"

/** Where a pairing meets at the relay, and the key its records are sealed under. */
export async function pairingChannel(secret: Bytes): Promise<DirectoryChannel> {
  const id = await deriveKey(secret, "synk/pairing-resource/v1", 16)
  const dek = await deriveKey(secret, "synk/pairing-key/v1")
  return {
    resourceId: `pairing:${toBase64Url(id)}`,
    keys: {
      current: () => Promise.resolve({ epoch: 0, dek }),
      forEpoch: (epoch) => Promise.resolve(epoch === 0 ? dek : undefined),
    },
  }
}

export interface PairingRequest {
  record: DeviceRecord
  requestedAt: number
}

export interface PairedNotebook {
  id: string
  name: string
}

export interface PairingApproval {
  /** The device that linked it. */
  by: string
  notebooks: PairedNotebook[]
  /** Notebooks it could not be linked into, and why, so the new device can say. */
  skipped: (PairedNotebook & { reason: string })[]
  approvedAt: number
}

export function requestPairing(doc: Y.Doc, record: DeviceRecord, now = Date.now()): void {
  doc.getMap<PairingRequest>(PAIRING_MAP).set("request", { record, requestedAt: now })
}

export function pairingRequest(doc: Y.Doc): PairingRequest | null {
  const request = doc.getMap<PairingRequest>(PAIRING_MAP).get("request")
  return request && typeof request.record?.did === "string" ? request : null
}

export function approvePairing(doc: Y.Doc, approval: PairingApproval): void {
  doc.getMap<PairingApproval>(PAIRING_MAP).set("approval", approval)
}

export function pairingApproval(doc: Y.Doc): PairingApproval | null {
  const approval = doc.getMap<PairingApproval>(PAIRING_MAP).get("approval")
  return approval && Array.isArray(approval.notebooks) ? approval : null
}
