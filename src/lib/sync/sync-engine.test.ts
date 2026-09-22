import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateAeadKey, toBase64Url } from "@/lib/crypto"
import {
  joinWorkspace,
  newWorkspace,
  RESOURCE,
  settle,
  staticKeys,
  stateVectorsEqual,
  textOf,
  type Client,
} from "@/test/sync-fixtures"
import { makeEnvelope, type Envelope } from "./envelope"
import { REMOTE_ORIGIN } from "./sync-engine"

describe("live convergence", () => {
  // The exit criterion, first half: two real clients converge over the relay.
  it("converges two clients through the envelope layer", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "Hello"))
    await settle(alice, bob)
    bob.engine.transact(() => bob.text.insert(bob.text.length, " world"))
    await settle(alice, bob)

    expect(textOf(alice)).toBe("Hello world")
    expect(textOf(bob)).toBe("Hello world")
    expect(stateVectorsEqual(alice, bob)).toBe(true)
  })

  // The loop guard: applying a remote update must not re-author it.
  it("creates exactly one envelope per local edit and none per remote apply", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "one"))
    await settle(alice, bob)

    expect(alice.engine.stats.published).toBe(1)
    expect(bob.engine.stats.published).toBe(0)
    expect(bob.engine.stats.applied).toBe(1)
  })

  it("carries only ciphertext to the relay", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")

    alice.engine.transact(() => alice.text.insert(0, "a secret sentence"))
    await settle(alice)

    const stored = workspace.relay.stored()
    expect(stored).toHaveLength(1)
    const serialised = JSON.stringify(stored)
    expect(serialised).not.toContain("a secret sentence")
    expect(serialised).not.toContain("secret")
  })

  it("keeps per-author sequence order under rapid edits", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    for (let i = 0; i < 10; i += 1) {
      alice.engine.transact(() => alice.text.insert(alice.text.length, String(i)))
    }
    await settle(alice, bob)

    expect(workspace.relay.stored().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(textOf(bob)).toBe("0123456789")
  })

  it("converges three clients", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")
    const carol = await joinWorkspace(workspace, "carol")

    alice.engine.transact(() => alice.text.insert(0, "a"))
    await settle(alice, bob, carol)
    bob.engine.transact(() => bob.text.insert(bob.text.length, "b"))
    await settle(alice, bob, carol)
    carol.engine.transact(() => carol.text.insert(carol.text.length, "c"))
    await settle(alice, bob, carol)

    expect(textOf(alice)).toBe("abc")
    expect(textOf(bob)).toBe("abc")
    expect(textOf(carol)).toBe("abc")
  })
})

describe("partition and catch-up", () => {
  // The exit criterion, second half.
  it("converges after a partition by replaying originals", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "shared-"))
    await settle(alice, bob)
    expect(textOf(bob)).toBe("shared-")

    // Bob drops off the relay entirely.
    bob.transport.connected = false
    alice.engine.transact(() => alice.text.insert(alice.text.length, "AAA"))
    bob.engine.transact(() => bob.text.insert(bob.text.length, "BBB"))
    await settle(alice, bob)
    expect(textOf(alice)).not.toBe(textOf(bob))

    // Reconnect: both catch up from the relay's store.
    bob.transport.connected = true
    await bob.engine.sync()
    await settle(alice, bob)
    await alice.engine.sync()
    await settle(alice, bob)

    expect(textOf(alice)).toBe(textOf(bob))
    expect(stateVectorsEqual(alice, bob)).toBe(true)
  })

  it("authors nothing new during catch-up", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    bob.transport.connected = false
    alice.engine.transact(() => alice.text.insert(0, "while away"))
    await settle(alice)

    bob.transport.connected = true
    const published = bob.engine.stats.published
    await bob.engine.sync()
    await settle(alice, bob)

    expect(bob.engine.stats.published).toBe(published)
    expect(textOf(bob)).toBe("while away")
  })

  // A client that was never online joins and reconstructs from the relay alone.
  it("brings a late joiner fully up to date", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    alice.engine.transact(() => alice.text.insert(0, "history "))
    await settle(alice)
    alice.engine.transact(() => alice.text.insert(alice.text.length, "accumulated"))
    await settle(alice)

    const late = await joinWorkspace(workspace, "late")
    expect(textOf(late)).toBe("")
    await late.engine.sync()
    await settle(alice, late)

    expect(textOf(late)).toBe("history accumulated")
  })

  it("survives a relay outage and resumes", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    workspace.relay.online = false
    alice.engine.transact(() => alice.text.insert(0, "during outage"))
    await settle(alice, bob)
    expect(textOf(bob)).toBe("")

    workspace.relay.online = true
    await bob.engine.sync()
    await settle(alice, bob)
    expect(textOf(bob)).toBe("during outage")
  })

  it("is idempotent when the same envelope arrives twice", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "once"))
    await settle(alice, bob)

    const envelope = alice.engine.log.all()[0]
    const before = Y.encodeStateVector(bob.doc)
    expect(await bob.engine.receive(envelope)).toBe(false)

    expect(textOf(bob)).toBe("once")
    expect(bob.engine.stats.duplicates).toBe(1)
    expect(Y.encodeStateVector(bob.doc)).toEqual(before)
  })

  // Repeated catch-ups must not re-apply or re-request what is already held.
  it("is stable across repeated syncs", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "settled"))
    await settle(alice, bob)

    expect(await bob.engine.sync()).toEqual({ pulled: 0, pushed: 0 })
    expect(await bob.engine.sync()).toEqual({ pulled: 0, pushed: 0 })
    expect(textOf(bob)).toBe("settled")
  })
})

describe("the responder is only a courier", () => {
  // Catch-up must replay originals. A synthesised diff carries no author
  // signature, so a tampering responder would be undetectable.
  it("serves byte-identical originals, never a merged diff", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    alice.engine.transact(() => alice.text.insert(0, "first "))
    await settle(alice)
    alice.engine.transact(() => alice.text.insert(alice.text.length, "second"))
    await settle(alice)

    const served = await workspace.relay.attach("observer").fetchSince({})
    const authored = alice.engine.log.all()

    expect(served).toHaveLength(2)
    expect(served.map((e) => e.sig)).toEqual(authored.map((e) => e.sig))
    expect(served.map((e) => e.ct)).toEqual(authored.map((e) => e.ct))
  })

  it("rejects an envelope the relay tampered with in transit", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "authentic"))
    await settle(alice)

    const original = alice.engine.log.all()[0]
    const flipped = toBase64Url(
      Uint8Array.from(atob(original.ct.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ).map((byte, index) => (index === 0 ? byte ^ 0xff : byte)),
    )

    expect(await bob.engine.receive({ ...original, ct: flipped })).toBe(false)
    expect(bob.engine.stats.rejected["bad-signature"]).toBe(1)
  })
})

describe("inbound rejection", () => {
  async function pair(): Promise<{ alice: Client; bob: Client; workspace: Awaited<ReturnType<typeof newWorkspace>> }> {
    const workspace = await newWorkspace()
    return {
      workspace,
      alice: await joinWorkspace(workspace, "alice"),
      bob: await joinWorkspace(workspace, "bob"),
    }
  }

  it("rejects an author absent from the directory", async () => {
    const { alice, bob } = await pair()
    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)

    const stranger = { ...alice.engine.log.all()[0], author: "did:key:z6MkStranger" }
    expect(await bob.engine.receive(stranger)).toBe(false)
    expect(bob.engine.stats.rejected["unknown-author"]).toBe(1)
  })

  it("rejects an envelope for a different resource", async () => {
    const { alice, bob } = await pair()
    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)

    const elsewhere = { ...alice.engine.log.all()[0], resourceId: "notebook:other" }
    expect(await bob.engine.receive(elsewhere)).toBe(false)
    expect(bob.engine.stats.rejected["wrong-resource"]).toBe(1)
  })

  it("rejects an envelope encrypted under an unknown epoch", async () => {
    const { alice, bob } = await pair()
    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)

    const futureEpoch = { ...alice.engine.log.all()[0], epoch: 99 }
    expect(await bob.engine.receive(futureEpoch)).toBe(false)
    // The header is the AEAD's aad, so a changed epoch also breaks the
    // signature - whichever check fires first, it is refused.
    const { rejected } = bob.engine.stats
    expect(rejected["unknown-epoch"] + rejected["bad-signature"]).toBe(1)
  })

  it("rejects malformed input without throwing", async () => {
    const { bob } = await pair()
    expect(await bob.engine.receive({} as Envelope)).toBe(false)
    expect(await bob.engine.receive(null as unknown as Envelope)).toBe(false)
    expect(await bob.engine.receive({ v: 1, author: 5 } as unknown as Envelope)).toBe(false)
    expect(bob.engine.stats.rejected.malformed).toBe(3)
  })

  // A member with a valid key but no directory presence cannot write.
  it("rejects a validly signed envelope from a non-member", async () => {
    const workspace = await newWorkspace()
    const bob = await joinWorkspace(workspace, "bob")

    // Mallory is admitted in a *different* workspace, so her key is real but
    // unknown to this directory.
    const elsewhere = await newWorkspace()
    const mallory = await joinWorkspace(elsewhere, "mallory")
    mallory.engine.transact(() => mallory.text.insert(0, "malicious"))
    await settle(mallory)

    const envelope = mallory.engine.log.all()[0]
    expect(await bob.engine.receive(envelope)).toBe(false)
    expect(bob.engine.stats.rejected["unknown-author"]).toBe(1)
  })
})

// Presence, if ever added, is its own signed and encrypted envelope type, not
// provider awareness. The slot exists in the format; this engine has no handler
// for it and says so rather than silently dropping it as malformed.
describe("envelope kind", () => {
  it("rejects a presence envelope as unsupported, not malformed", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    const { epoch, dek } = await staticKeys(workspace.dek).current()
    const presence = await makeEnvelope({
      signingKey: alice.signingKey,
      author: alice.did,
      seq: 1,
      resourceId: RESOURCE,
      epoch,
      dek,
      kind: "presence",
      update: new TextEncoder().encode(JSON.stringify({ cursor: 4 })),
    })

    expect(await bob.engine.receive(presence)).toBe(false)
    expect(bob.engine.stats.rejected["unsupported-kind"]).toBe(1)
    expect(bob.engine.stats.rejected.malformed).toBe(0)
  })

  it("rejects an unknown kind as malformed", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "x"))
    await settle(alice)

    const bogus = { ...alice.engine.log.all()[0], kind: "awareness" } as unknown as Envelope
    expect(await bob.engine.receive(bogus)).toBe(false)
    expect(bob.engine.stats.rejected.malformed).toBe(1)
  })
})

describe("attribution integrity", () => {
  // The M2 invariant, now enforced. An author who encrypts operations carrying
  // someone else's client id is refused, so bylines cannot be forged.
  it("rejects an update whose operations claim another device's client id", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    // Alice builds an update under Bob's client id and seals it as herself.
    const forgery = new Y.Doc()
    forgery.clientID = bob.clientId
    forgery.getText("content").insert(0, "bob said this")

    const { epoch, dek } = await staticKeys(workspace.dek).current()
    const envelope = await makeEnvelope({
      signingKey: alice.signingKey,
      author: alice.did,
      seq: 99,
      resourceId: RESOURCE,
      epoch,
      dek,
      update: Y.encodeStateAsUpdate(forgery),
    })

    // Signed by Alice, authorised, decryptable - and still refused, because the
    // operations inside claim Bob's client id.
    expect(await bob.engine.receive(envelope)).toBe(false)
    expect(bob.engine.stats.rejected["forged-client-id"]).toBe(1)
    expect(textOf(bob)).toBe("")
  })

  it("accepts a delete of another author's content", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    alice.engine.transact(() => alice.text.insert(0, "delete me"))
    await settle(alice, bob)

    // A delete-only update has no structs but its delete set names Alice.
    bob.engine.transact(() => bob.text.delete(0, 7))
    await settle(alice, bob)

    expect(textOf(alice)).toBe("me")
    expect(alice.engine.stats.rejected["forged-client-id"]).toBe(0)
  })
})

describe("key handling", () => {
  it("cannot decrypt under a different notebook key", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const outsider = await joinWorkspace(workspace, "outsider", {
      keys: staticKeys(generateAeadKey()),
    })

    alice.engine.transact(() => alice.text.insert(0, "members only"))
    await settle(alice, outsider)

    expect(textOf(outsider)).toBe("")
    expect(outsider.engine.stats.rejected.undecryptable).toBe(1)
  })
})

describe("lifecycle", () => {
  it("stops publishing and receiving once closed", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")
    const bob = await joinWorkspace(workspace, "bob")

    bob.engine.close()
    alice.engine.transact(() => alice.text.insert(0, "after close"))
    await settle(alice)

    expect(textOf(bob)).toBe("")

    bob.engine.transact(() => bob.text.insert(0, "local only"))
    await settle(bob)
    expect(bob.engine.stats.published).toBe(0)
  })

  it("does not re-broadcast an update applied with the remote origin", async () => {
    const workspace = await newWorkspace()
    const alice = await joinWorkspace(workspace, "alice")

    const scratch = new Y.Doc()
    scratch.clientID = alice.clientId
    scratch.getText("content").insert(0, "injected")
    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(scratch), REMOTE_ORIGIN)
    await settle(alice)

    expect(alice.engine.stats.published).toBe(0)
  })
})
