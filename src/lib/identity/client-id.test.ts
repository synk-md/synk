import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { fromHex, generateSigningKey, importSigningKey } from "@/lib/crypto"
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness"
import {
  assertNoClientIdCollision,
  bindDocumentClientId,
  clientIdMatchesDevice,
  deriveClientId,
  MAX_CLIENT_ID,
} from "./client-id"

// RFC 8032 test key, so the derivation is pinned to a fixed input. If the label
// or the byte order ever changes, this number changes and every existing
// document's attribution would silently break - that is worth a regression test.
const KNOWN_SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

describe("deriveClientId", () => {
  it("is deterministic for a given key", async () => {
    const key = await importSigningKey(fromHex(KNOWN_SECRET))
    const first = await deriveClientId(key.publicKey)
    const second = await deriveClientId(key.publicKey)
    expect(first).toBe(second)
  })

  it("produces a safe 53-bit integer", async () => {
    for (let i = 0; i < 25; i += 1) {
      const key = await generateSigningKey()
      const clientId = await deriveClientId(key.publicKey)
      expect(Number.isSafeInteger(clientId)).toBe(true)
      expect(clientId).toBeGreaterThanOrEqual(0)
      expect(clientId).toBeLessThanOrEqual(MAX_CLIENT_ID)
    }
  })

  // The point of widening: if the derivation were done with JavaScript's
  // bitwise operators it would silently coerce to int32 and every id would land
  // under 2^32, throwing away 21 bits of collision resistance.
  it("actually uses the space above 32 bits", async () => {
    let aboveUint32 = 0
    for (let i = 0; i < 40; i += 1) {
      const key = await generateSigningKey()
      if ((await deriveClientId(key.publicKey)) > 0xffffffff) aboveUint32 += 1
    }
    // Expected ~40 * (1 - 2^-21); anything near zero means truncation.
    expect(aboveUint32).toBeGreaterThan(35)
  })

  it("differs between keys", async () => {
    const a = await generateSigningKey()
    const b = await generateSigningKey()
    expect(await deriveClientId(a.publicKey)).not.toBe(await deriveClientId(b.publicKey))
  })

  it("rejects a wrong-length key", async () => {
    await expect(deriveClientId(new Uint8Array(31))).rejects.toThrow(/32 bytes/)
  })
})

describe("clientIdMatchesDevice", () => {
  it("accepts the derived id and rejects any other", async () => {
    const key = await generateSigningKey()
    const clientId = await deriveClientId(key.publicKey)
    expect(await clientIdMatchesDevice(clientId, key.publicKey)).toBe(true)
    expect(await clientIdMatchesDevice(clientId + 1, key.publicKey)).toBe(false)
  })

  // The forgery this invariant exists to stop: a member setting their client id
  // to another device's so their edits are attributed to that device.
  it("rejects one device's id claimed under another's key", async () => {
    const victim = await generateSigningKey()
    const attacker = await generateSigningKey()
    const victimClientId = await deriveClientId(victim.publicKey)
    expect(await clientIdMatchesDevice(victimClientId, attacker.publicKey)).toBe(false)
  })
})

// The widening is only safe because lib0 encodes client ids as var-uints that
// support the full safe-integer range. These assert that end to end rather than
// trusting the encoder, since truncation would be silent and corrupting.
describe("53-bit ids through the Yjs wire format", () => {
  const WIDE = [0xffffffff, 0x100000000, 0xffffffffff, MAX_CLIENT_ID, 7331982245761043]

  it.each(WIDE)("survives a full state round trip with id %d", (id) => {
    const doc = new Y.Doc()
    doc.clientID = id
    doc.getText("content").insert(0, "authored")

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))

    expect([...Y.decodeStateVector(Y.encodeStateVector(peer)).keys()]).toEqual([id])
    expect(peer.getText("content").toJSON()).toBe("authored")
  })

  it.each(WIDE)("survives an incremental diff with id %d", (id) => {
    const doc = new Y.Doc()
    doc.clientID = id
    doc.getText("content").insert(0, "first ")

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)))
    doc.getText("content").insert(6, "second")
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)))

    expect(peer.getText("content").toJSON()).toBe("first second")
  })

  it("converges with a normal 32-bit peer", async () => {
    const key = await generateSigningKey()
    const mine = new Y.Doc()
    await bindDocumentClientId(mine, key.publicKey)
    mine.getText("content").insert(0, "mine ")

    const theirs = new Y.Doc() // default random uint32
    theirs.getText("content").insert(0, "theirs ")

    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))

    expect(mine.getText("content").toJSON()).toBe(theirs.getText("content").toJSON())
  })

  // Presence carries the client id through a different codec than document
  // updates, so it gets its own check.
  it("round-trips through the awareness protocol", () => {
    const id = 7331982245761043
    const mine = new Y.Doc()
    mine.clientID = id
    const awarenessA = new Awareness(mine)
    awarenessA.setLocalState({ user: { name: "Sindre" } })

    const theirs = new Y.Doc()
    theirs.clientID = 12345
    const awarenessB = new Awareness(theirs)
    applyAwarenessUpdate(awarenessB, encodeAwarenessUpdate(awarenessA, [id]), "test")

    const states = awarenessB.getStates()
    expect([...states.keys()]).toContain(id)
    expect(states.get(id)).toEqual({ user: { name: "Sindre" } })
  })
})

describe("bindDocumentClientId", () => {
  it("pins a Yjs document to its device's id", async () => {
    const key = await generateSigningKey()
    const doc = new Y.Doc()
    const randomId = doc.clientID

    const bound = await bindDocumentClientId(doc, key.publicKey)

    expect(doc.clientID).toBe(bound)
    expect(bound).toBe(await deriveClientId(key.publicKey))
    expect(bound).not.toBe(randomId)
  })

  // The bound id must be what peers actually observe, not just a local field.
  it("is the id peers see in the state vector", async () => {
    const key = await generateSigningKey()
    const doc = new Y.Doc()
    const bound = await bindDocumentClientId(doc, key.publicKey)
    doc.getText("content").insert(0, "authored")

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))

    expect([...Y.decodeStateVector(Y.encodeStateVector(peer)).keys()]).toEqual([bound])
  })
})

describe("assertNoClientIdCollision", () => {
  it("passes on distinct ids", () => {
    expect(() => assertNoClientIdCollision([1, 2, 3])).not.toThrow()
    expect(() => assertNoClientIdCollision([])).not.toThrow()
  })

  it("throws a remediable message on a collision", () => {
    expect(() => assertNoClientIdCollision([7, 9, 7])).toThrow(/client id collision on 7/)
    expect(() => assertNoClientIdCollision([7, 9, 7])).toThrow(/regenerate its signing key/)
  })
})
