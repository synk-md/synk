import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { generateInvitationSecret } from "@/lib/directory"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import { MemoryRelay } from "@/lib/sync"

import { approvePairing, pairingApproval, pairingChannel, pairingRequest, requestPairing } from "./pairing"
import { createDirectoryReplica } from "./replicas"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

describe("a pairing channel", () => {
  /** The relay holds the request and the approval, and can read neither. */
  it("carries the request and the approval between devices that hold the code", async () => {
    const relay = new MemoryRelay()
    const { secret } = generateInvitationSecret()
    const channel = await pairingChannel(secret)
    const laptop = await aDevice()
    const phone = await aDevice()

    const phoneDoc = new Y.Doc()
    const phoneEngine = createDirectoryReplica({ doc: phoneDoc, channel, device: phone, transport: relay.attach("phone") })
    requestPairing(phoneDoc, phone.record)
    await phoneEngine.flush()

    const laptopDoc = new Y.Doc()
    const laptopEngine = createDirectoryReplica({ doc: laptopDoc, channel, device: laptop, transport: relay.attach("laptop") })
    await laptopEngine.sync()
    expect(pairingRequest(laptopDoc)?.record.did).toBe(phone.did)

    approvePairing(laptopDoc, { by: laptop.did, notebooks: [{ id: "travel", name: "Travel" }], skipped: [], approvedAt: 1 })
    await laptopEngine.flush()
    await phoneEngine.flush()
    expect(pairingApproval(phoneDoc)?.notebooks).toEqual([{ id: "travel", name: "Travel" }])

    expect(JSON.stringify(relay.stored())).not.toContain("Travel")
    expect(channel.resourceId).not.toContain(phone.did)
  })

  it("is a different place for every code", async () => {
    const a = await pairingChannel(generateInvitationSecret().secret)
    const b = await pairingChannel(generateInvitationSecret().secret)
    expect(a.resourceId).not.toBe(b.resourceId)
  })
})
