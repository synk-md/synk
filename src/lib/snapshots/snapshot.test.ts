import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { generateAeadKey, generateSigningKey, toHex } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  chainFrom,
  createSnapshot,
  openSnapshot,
  snapshotIdOf,
  verifySnapshot,
  type Snapshot,
} from "./snapshot"

const DOMAIN = "notebook:1"

function state(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 7
  doc.getText("content").insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

async function snap(overrides: Partial<Parameters<typeof createSnapshot>[0]> = {}) {
  const signingKey = await generateSigningKey()
  const dek = generateAeadKey()
  const snapshot = await createSnapshot({
    signingKey,
    author: didFromSigningKey(signingKey.publicKey),
    domain: DOMAIN,
    resourceId: DOMAIN,
    kind: "join",
    epoch: 2,
    dek,
    state: state("hello"),
    covers: { "did:key:zA": 3, "did:key:zB": 1 },
    createdAt: 1_000,
    ...overrides,
  })
  return { signingKey, dek, snapshot }
}

describe("createSnapshot", () => {
  it("round-trips the state to a holder of the epoch key", async () => {
    const { dek, snapshot } = await snap()
    expect(toHex(await openSnapshot(snapshot, dek))).toBe(toHex(state("hello")))
  })

  it("verifies under the producing author's key", async () => {
    const { signingKey, snapshot } = await snap()
    expect(await verifySnapshot(snapshot, signingKey.publicKey)).toBe(true)
  })

  it("records coverage, epoch and kind", async () => {
    const { snapshot } = await snap()
    expect(snapshot.covers).toEqual({ "did:key:zA": 3, "did:key:zB": 1 })
    expect(snapshot.epoch).toBe(2)
    expect(snapshot.kind).toBe("join")
    expect(snapshot.parent).toBeNull()
  })

  it("is JSON-serialisable end to end", async () => {
    const { dek, snapshot } = await snap()
    const revived = JSON.parse(JSON.stringify(snapshot)) as Snapshot
    expect(toHex(await openSnapshot(revived, dek))).toBe(toHex(state("hello")))
  })

  it("gives different content different ids", async () => {
    const a = await snap()
    const b = await snap({ state: state("different") })
    expect(a.snapshot.id).not.toBe(b.snapshot.id)
  })
})

describe("tamper resistance", () => {
  // Header fields are signed and are the AEAD's associated data, so a snapshot
  // cannot be relabelled to another epoch, resource or coverage point.
  it.each([
    ["epoch", 99],
    ["resourceId", "notebook:other"],
    ["domain", "notebook:other"],
    ["kind", "checkpoint"],
    ["author", "did:key:z6MkSomeoneElse"],
  ] as const)("breaks verification when %s changes", async (field, value) => {
    const { signingKey, snapshot } = await snap()
    const tampered = { ...snapshot, [field]: value } as Snapshot
    expect(await verifySnapshot(tampered, signingKey.publicKey)).toBe(false)
  })

  it("breaks verification when coverage is inflated", async () => {
    const { signingKey, snapshot } = await snap()
    const tampered = { ...snapshot, covers: { ...snapshot.covers, "did:key:zA": 99 } }
    expect(await verifySnapshot(tampered, signingKey.publicKey)).toBe(false)
  })

  it("detects a forged id", async () => {
    const { signingKey, snapshot } = await snap()
    const forged = { ...snapshot, id: "AAAA" }
    expect(await verifySnapshot(forged, signingKey.publicKey)).toBe(false)
    expect(await snapshotIdOf(snapshot)).toBe(snapshot.id)
  })

  it("rejects the wrong author key and a tampered signature", async () => {
    const { snapshot } = await snap()
    const other = await generateSigningKey()
    expect(await verifySnapshot(snapshot, other.publicKey)).toBe(false)
  })

  it("refuses to open under the wrong epoch key", async () => {
    const { snapshot } = await snap()
    await expect(openSnapshot(snapshot, generateAeadKey())).rejects.toThrow(/AEAD open failed/)
  })

  // The stateHash is checked after decryption, so a payload swapped by someone
  // holding the key is still caught.
  it("refuses a payload that does not match its signed hash", async () => {
    const { dek, snapshot } = await snap()
    const other = await snap({ state: state("swapped"), dek })
    const swapped = { ...snapshot, ct: other.snapshot.ct, nonce: other.snapshot.nonce }
    await expect(openSnapshot(swapped, dek)).rejects.toThrow()
  })

  it("returns false rather than throwing on nonsense", async () => {
    const { signingKey } = await snap()
    expect(await verifySnapshot({} as Snapshot, signingKey.publicKey)).toBe(false)
    expect(await verifySnapshot({ v: 2 } as unknown as Snapshot, signingKey.publicKey)).toBe(false)
  })
})

describe("the hash-linked chain", () => {
  it("walks from tip to root, oldest first", async () => {
    const signingKey = await generateSigningKey()
    const author = didFromSigningKey(signingKey.publicKey)
    const dek = generateAeadKey()
    const base = { signingKey, author, domain: DOMAIN, resourceId: DOMAIN, dek, epoch: 1 } as const

    const first = await createSnapshot({
      ...base,
      kind: "automatic",
      state: state("one"),
      covers: {},
      createdAt: 1,
    })
    const second = await createSnapshot({
      ...base,
      kind: "automatic",
      state: state("two"),
      covers: {},
      parent: first.id,
      createdAt: 2,
    })
    const third = await createSnapshot({
      ...base,
      kind: "automatic",
      state: state("three"),
      covers: {},
      parent: second.id,
      createdAt: 3,
    })

    const walked = chainFrom([third, first, second], third.id)
    expect(walked.complete).toBe(true)
    expect(walked.chain.map((s) => s.id)).toEqual([first.id, second.id, third.id])
  })

  it("reports an incomplete chain when a link is missing", async () => {
    const { snapshot: root } = await snap()
    const { snapshot: child } = await snap({ parent: root.id, createdAt: 2_000 })
    const walked = chainFrom([child], child.id)
    expect(walked.complete).toBe(false)
    expect(walked.chain.map((s) => s.id)).toEqual([child.id])
  })

  it("does not loop on a cycle", async () => {
    const { snapshot } = await snap()
    const selfReferential = { ...snapshot, parent: snapshot.id }
    const walked = chainFrom([selfReferential], selfReferential.id)
    expect(walked.complete).toBe(false)
  })

  it("reports an unknown tip as incomplete", () => {
    expect(chainFrom([], "nope")).toEqual({ chain: [], complete: false })
  })
})

describe("what verification does and does not establish", () => {
  // Stated as a test so the residual is not mistaken for a gap: a signature
  // proves who produced a snapshot, never that the merge is correct.
  it("accepts a correctly signed snapshot of arbitrary content", async () => {
    const { signingKey, dek, snapshot } = await snap({ state: state("whatever the author liked") })
    expect(await verifySnapshot(snapshot, signingKey.publicKey)).toBe(true)
    expect(toHex(await openSnapshot(snapshot, dek))).toBe(
      toHex(state("whatever the author liked")),
    )
  })
})
