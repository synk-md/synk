import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Y from "yjs"
import { setCurveBackend, resetCurveSupport, toHex, utf8, verifySignature } from "@/lib/crypto"
import { bindDocumentClientId, deriveClientId } from "./client-id"
import { verifyDeviceRecord } from "./device-record"
import {
  forgetDeviceIdentity,
  getOrCreateDeviceIdentity,
  resetDeviceIdentityCache,
} from "./device-identity"
import {
  loadStoredDeviceIdentity,
  resetDeviceDatabaseConnection,
  saveStoredDeviceIdentity,
} from "./device-store"

/** Simulate a page reload: storage survives, in-memory state does not. */
function reload(): void {
  resetDeviceIdentityCache()
  resetDeviceDatabaseConnection()
}

beforeEach(async () => {
  await forgetDeviceIdentity()
  reload()
})

afterEach(() => {
  resetCurveSupport()
})

describe("getOrCreateDeviceIdentity", () => {
  it("generates a usable identity on first run", async () => {
    const identity = await getOrCreateDeviceIdentity()
    expect(identity.did).toMatch(/^did:key:z6Mk/)
    expect(await verifyDeviceRecord(identity.record)).toBe(true)

    const message = utf8("an envelope")
    const signature = await identity.signingKey.sign(message)
    expect(await verifySignature(identity.signingKey.publicKey, message, signature)).toBe(true)
  })

  it("returns the same object within a session", async () => {
    expect(await getOrCreateDeviceIdentity()).toBe(await getOrCreateDeviceIdentity())
  })

  // The M2 exit criterion.
  it("keeps a stable signed identity and client id across reloads", async () => {
    const first = await getOrCreateDeviceIdentity()
    reload()
    const second = await getOrCreateDeviceIdentity()

    expect(second.did).toBe(first.did)
    expect(second.clientId).toBe(first.clientId)
    expect(second.record.sig).toBe(first.record.sig)
    expect(toHex(second.signingKey.publicKey)).toBe(toHex(first.signingKey.publicKey))
    expect(toHex(second.sealingKey.publicKey)).toBe(toHex(first.sealingKey.publicKey))
  })

  it("can still sign and open after a reload", async () => {
    const first = await getOrCreateDeviceIdentity()
    reload()
    const second = await getOrCreateDeviceIdentity()

    const message = utf8("signed after reload")
    const signature = await second.signingKey.sign(message)
    expect(await verifySignature(first.signingKey.publicKey, message, signature)).toBe(true)
  })

  // The reason identity lives in IndexedDB rather than localStorage.
  it("keeps the restored key non-extractable", async () => {
    await getOrCreateDeviceIdentity()
    reload()
    const restored = await getOrCreateDeviceIdentity()

    expect(restored.signingKey.backend).toBe("webcrypto")
    expect(restored.signingKey.extractable).toBe(false)
    expect(await restored.signingKey.exportSecretKey()).toBeNull()
    expect(restored.sealingKey.extractable).toBe(false)
    expect(await restored.sealingKey.exportSecretKey()).toBeNull()
  })

  it("does not race itself into two identities", async () => {
    const [a, b, c] = await Promise.all([
      getOrCreateDeviceIdentity(),
      getOrCreateDeviceIdentity(),
      getOrCreateDeviceIdentity(),
    ])
    expect(b.did).toBe(a.did)
    expect(c.did).toBe(a.did)
  })

  it("binds a document to the identity's client id", async () => {
    const identity = await getOrCreateDeviceIdentity()
    const doc = new Y.Doc()
    await bindDocumentClientId(doc, identity.signingKey.publicKey)
    expect(doc.clientID).toBe(identity.clientId)
    expect(doc.clientID).toBe(await deriveClientId(identity.signingKey.publicKey))
  })
})

describe("tampered storage", () => {
  // IndexedDB is not a trust boundary - any script on the origin can write to
  // it, so a stored record is re-verified rather than trusted.
  it("discards a stored record that no longer verifies", async () => {
    const original = await getOrCreateDeviceIdentity()
    const stored = await loadStoredDeviceIdentity()
    expect(stored).toBeDefined()

    await saveStoredDeviceIdentity({
      signing: stored!.signing,
      sealing: stored!.sealing,
      record: { ...stored!.record, clientId: stored!.record.clientId + 1 },
    })
    reload()

    const rebuilt = await getOrCreateDeviceIdentity()
    expect(rebuilt.did).not.toBe(original.did)
    expect(await verifyDeviceRecord(rebuilt.record)).toBe(true)
  })
})

describe("forgetDeviceIdentity", () => {
  it("is irreversible - a new identity is generated", async () => {
    const first = await getOrCreateDeviceIdentity()
    await forgetDeviceIdentity()
    const second = await getOrCreateDeviceIdentity()
    expect(second.did).not.toBe(first.did)
    expect(await loadStoredDeviceIdentity()).toBeDefined()
  })
})

describe("noble fallback", () => {
  it("persists and restores an identity, admitting the key is extractable", async () => {
    setCurveBackend("noble")
    const first = await getOrCreateDeviceIdentity()
    expect(first.signingKey.backend).toBe("noble")
    expect(first.signingKey.extractable).toBe(true)

    reload()
    const second = await getOrCreateDeviceIdentity()
    expect(second.did).toBe(first.did)
    expect(second.clientId).toBe(first.clientId)
    expect(await second.signingKey.exportSecretKey()).not.toBeNull()
  })
})
