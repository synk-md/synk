/**
 * Who owns a notebook now: the genesis owner, and every hand-over since.
 *
 * Two ways ownership passes on, both for when the owner's device is lost:
 *
 * - **A standby.** The owner names one of their own devices, ahead of time, as
 *   able to take over. That device later signs the succession to itself.
 * - **The recovery code.** The genesis names the code's key; a succession it
 *   signs names any device, and the next code.
 *
 * A stolen owner device can name standbys of its own, so the code is the last
 * word: a recovery from an owner beats every standby succession from them, and
 * two standby successions from one owner, with no recovery, leave it disputed
 * until the code settles it. The code itself changes only by a recovery, so a
 * stolen device cannot swap it.
 *
 * Pure, over records already gathered, so the relay can follow it too.
 */

import type * as Y from "yjs"

import { fromBase64Url, toBase64Url, utf8, verifySignature, type Bytes, type SigningKey } from "@/lib/crypto"
import { slotFor, valuesIn } from "@/lib/directory"
import { publicKeyFromDid } from "@/lib/identity"

import type { WorkspaceGenesis } from "./genesis"
import type { RecoveryKey } from "./recovery-code"

export const STANDBY_MAP = "workspace:standbys"
export const SUCCESSION_MAP = "workspace:successions"
const VERSION = 1

export interface StandbyBody {
  v: typeof VERSION
  workspace: string
  /** The owner naming it. */
  owner: string
  /** The device that may take over. */
  device: string
  /**
   * Not only if the owner's device is lost: the owner offers ownership now,
   * and keeps their device. Signed, so the offer is the owner's word.
   */
  handover?: true
  at: number
}

export interface Standby extends StandbyBody {
  sig: string
}

export interface SuccessionBody {
  v: typeof VERSION
  workspace: string
  from: string
  to: string
  /** `standby`: signed by `to`, named by `from`. `recovery`: signed by the recovery key. */
  by: "standby" | "recovery"
  /** Who signed it: `to`, or the recovery key's `did:key`. */
  signer: string
  /** After a recovery, the code that replaces the one just used. */
  nextRecovery?: RecoveryKey
  at: number
}

export interface Succession extends SuccessionBody {
  sig: string
}

function standbyBytes(body: StandbyBody): Bytes {
  return utf8(
    [
      "synk/standby/v1",
      String(body.v),
      body.workspace,
      body.owner,
      body.device,
      String(body.at),
      // Only when present, so a standby from before verifies unchanged.
      ...(body.handover ? ["handover"] : []),
    ].join("\n"),
  )
}

function successionBytes(body: SuccessionBody): Bytes {
  return utf8(
    [
      "synk/succession/v1",
      String(body.v),
      body.workspace,
      body.from,
      body.to,
      body.by,
      body.signer,
      body.nextRecovery?.did ?? "",
      body.nextRecovery?.sealingDid ?? "",
      String(body.at),
    ].join("\n"),
  )
}

async function signedBy(did: string, bytes: Bytes, sig: string): Promise<boolean> {
  try {
    return await verifySignature(publicKeyFromDid(did, "ed25519"), bytes, fromBase64Url(sig))
  } catch {
    return false
  }
}

export async function nameStandby(options: {
  signingKey: SigningKey
  owner: string
  workspace: string
  device: string
  handover?: boolean
  at?: number
}): Promise<Standby> {
  const body: StandbyBody = {
    v: VERSION,
    workspace: options.workspace,
    owner: options.owner,
    device: options.device,
    ...(options.handover ? { handover: true as const } : {}),
    at: options.at ?? Date.now(),
  }
  return { ...body, sig: toBase64Url(await options.signingKey.sign(standbyBytes(body))) }
}

export async function signSuccession(
  options: Omit<SuccessionBody, "v" | "at"> & { signingKey: SigningKey; at?: number },
): Promise<Succession> {
  const { signingKey, at, ...rest } = options
  const body: SuccessionBody = { v: VERSION, ...rest, at: at ?? Date.now() }
  return { ...body, sig: toBase64Url(await signingKey.sign(successionBytes(body))) }
}

/** Signed by the owner it names, for this workspace. */
export async function verifyStandby(standby: Standby, workspace: string): Promise<boolean> {
  if (standby?.v !== VERSION || standby.workspace !== workspace) return false
  const { sig, ...body } = standby
  return signedBy(standby.owner, standbyBytes(body), sig)
}

export function putStandby(doc: Y.Doc, standby: Standby): void {
  doc.getMap<Standby>(STANDBY_MAP).set(slotFor(standby.device, standby.sig), standby)
}

export function putSuccession(doc: Y.Doc, succession: Succession): void {
  doc.getMap<Succession>(SUCCESSION_MAP).set(slotFor(succession.to, succession.sig), succession)
}

export function standbysIn(doc: Y.Doc): Standby[] {
  return valuesIn<Standby>(doc, STANDBY_MAP)
}

export function successionsIn(doc: Y.Doc): Succession[] {
  return valuesIn<Succession>(doc, SUCCESSION_MAP)
}

export interface Lineage {
  status: "established" | "disputed"
  /** The owner now. Null while disputed. */
  owner: string | null
  /** Every owner, genesis first, up to the one now. */
  owners: string[]
  /** The code that can recover from the owner now. */
  recovery: RecoveryKey | null
}

const bySig = <T extends { sig: string }>(a: T, b: T) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0)

/** Follow the hand-overs from a genesis. */
export async function resolveLineage(
  genesis: WorkspaceGenesis,
  standbys: readonly Standby[],
  successions: readonly Succession[],
): Promise<Lineage> {
  let owner = genesis.owner
  let recovery: RecoveryKey | null =
    genesis.recovery && genesis.recoverySealing ? { did: genesis.recovery, sealingDid: genesis.recoverySealing } : null
  const owners = [owner]

  const named = async (from: string, device: string) => {
    for (const standby of standbys) {
      if (standby?.v !== VERSION || standby.workspace !== genesis.workspace) continue
      if (standby.owner !== from || standby.device !== device) continue
      const { sig, ...body } = standby
      if (await signedBy(from, standbyBytes(body), sig)) return true
    }
    return false
  }

  for (let step = 0; step < 64; step += 1) {
    const recoveries: Succession[] = []
    const handovers: Succession[] = []
    for (const succession of successions) {
      if (succession?.v !== VERSION || succession.workspace !== genesis.workspace || succession.from !== owner) continue
      if (owners.includes(succession.to)) continue
      const { sig, ...body } = succession
      if (!(await signedBy(succession.signer, successionBytes(body), sig))) continue
      if (succession.by === "recovery" && recovery && succession.signer === recovery.did && succession.nextRecovery) {
        recoveries.push(succession)
      } else if (succession.by === "standby" && succession.signer === succession.to && (await named(owner, succession.to))) {
        handovers.push(succession)
      }
    }

    let next: Succession | undefined
    if (recoveries.length > 0) next = [...recoveries].sort(bySig)[0]
    else if (new Set(handovers.map((each) => each.to)).size > 1) {
      return { status: "disputed", owner: null, owners, recovery }
    } else next = handovers[0]
    if (!next) break

    owner = next.to
    owners.push(owner)
    if (next.by === "recovery") recovery = next.nextRecovery ?? null
  }

  return { status: "established", owner, owners, recovery }
}
