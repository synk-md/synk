/**
 * Fixtures for the key tests: members identified by their sealing keys, and a
 * domain to cut epochs in.
 */

import { generateSealingKey, type SealingKey } from "@/lib/crypto"
import { didFromSealingKey } from "@/lib/identity"
import { KeyDomainAdmin, type KeyRecipient, type SealedEpochKey } from "@/lib/keys"

export const NOTEBOOK = "notebook:1"

export interface Member extends KeyRecipient {
  name: string
  sealingKey: SealingKey
}

export async function newMember(name: string): Promise<Member> {
  const sealingKey = await generateSealingKey()
  return { name, sealingKey, sealingDid: didFromSealingKey(sealingKey.publicKey) }
}

/** A domain founded by the given members, with their sealed genesis copies. */
export async function foundDomain(
  founders: readonly Member[],
  domain = NOTEBOOK,
): Promise<{ admin: KeyDomainAdmin; keyring: SealedEpochKey[] }> {
  const { admin, sealed } = await KeyDomainAdmin.create(domain, founders, { createdAt: 1_000 })
  return { admin, keyring: [...sealed] }
}
