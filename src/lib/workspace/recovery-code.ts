/**
 * A notebook's recovery code: shown once when it is created, and never kept on
 * any device - a stolen laptop must not carry the way to take the notebook
 * back from whoever stole it.
 *
 * It names the notebook and holds a secret. From the secret come a signing key,
 * which may pass ownership to a new device, and a sealing key, which every key
 * segment is sealed to as well - so the code recovers the notes as well as
 * control of them, and is as sensitive as the notebook itself.
 */

import { base32crockford } from "@scure/base"

import { deriveKey, importSealingKey, importSigningKey, randomBytes, type Bytes } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

export const RECOVERY_SECRET_BYTES = 20
const GROUP = 4

export interface RecoveryCode {
  notebookId: string
  secret: Bytes
  /** What the person is shown and types back: `<notebook>.<secret>`. */
  text: string
}

/** The public half, as the genesis and every recovery name it. */
export interface RecoveryKey {
  did: string
  sealingDid: string
}

function format(notebookId: string, secret: Bytes): string {
  const encoded = base32crockford.encode(secret)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += GROUP) groups.push(encoded.slice(i, i + GROUP))
  return `${notebookId}.${groups.join("-")}`
}

export function generateRecoveryCode(notebookId: string): RecoveryCode {
  const secret = randomBytes(RECOVERY_SECRET_BYTES)
  return { notebookId, secret, text: format(notebookId, secret) }
}

/** Tolerant of case, spacing and dashes in the secret; the notebook's id is as written. */
export function parseRecoveryCode(text: string): RecoveryCode {
  const trimmed = text.trim()
  const dot = trimmed.indexOf(".")
  if (dot < 1) throw new Error("That is not a recovery code: it should start with the notebook's id and a dot.")
  const notebookId = trimmed.slice(0, dot)
  const cleaned = trimmed.slice(dot + 1).replace(/[\s-]/g, "").toUpperCase()
  let secret: Bytes
  try {
    secret = base32crockford.decode(cleaned)
  } catch {
    throw new Error("That recovery code has characters a code never contains.")
  }
  if (secret.length !== RECOVERY_SECRET_BYTES) throw new Error("That recovery code is the wrong length.")
  return { notebookId, secret, text: format(notebookId, secret) }
}

/** The code as a device of its own: what signs a recovery, and what opens the keys sealed to it. */
export async function recoveryIdentity(secret: Bytes): Promise<DeviceIdentity> {
  const signingKey = await importSigningKey(await deriveKey(secret, "synk/recovery-signing/v1"), { extractable: true })
  const sealingKey = await importSealingKey(await deriveKey(secret, "synk/recovery-sealing/v1"))
  const record = await createDeviceRecord(signingKey, sealingKey, { createdAt: 0 })
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

export async function recoveryKeyOf(secret: Bytes): Promise<RecoveryKey> {
  const identity = await recoveryIdentity(secret)
  return { did: identity.did, sealingDid: identity.record.sealingDid }
}
