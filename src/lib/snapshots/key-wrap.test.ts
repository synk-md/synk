import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { generateAeadKey, generateSigningKey, toHex, type Bytes } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"

import {
  coversCurrentState,
  reachableWraps,
  unwrapSnapshotKey,
  verifySnapshotWrap,
} from "./key-wrap"
import {
  createSnapshot,
  openSnapshot,
  openSnapshotWith,
  rewrapSnapshot,
  snapshotIdOf,
  verifySnapshot,
  type Snapshot,
} from "./snapshot"

const DOMAIN = "notebook:1"

function state(text: string): Bytes {
  const doc = new Y.Doc()
  doc.clientID = 7
  doc.getText("content").insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

async function aSnapshot(covers: Record<string, number> = { "did:key:zA": 3 }) {
  const signingKey = await generateSigningKey()
  const author = didFromSigningKey(signingKey.publicKey)
  const epoch2 = generateAeadKey()
  const snapshot = await createSnapshot({
    signingKey,
    author,
    domain: DOMAIN,
    resourceId: DOMAIN,
    kind: "join",
    epoch: 2,
    dek: epoch2,
    state: state("hello"),
    covers,
    createdAt: 1_000,
  })
  return { signingKey, author, epoch2, snapshot }
}

/** A keyring that can open exactly the listed epochs. */
function keys(available: Record<number, Bytes>) {
  return {
    keyFor: (epoch: number) => Promise.resolve(available[epoch]),
    readableEpochs: () => Object.keys(available).map(Number),
  }
}

describe("a snapshot's content key", () => {
  it("is its own, sealed under the epoch rather than being the epoch key", async () => {
    const { snapshot, epoch2 } = await aSnapshot()

    // Opening with the epoch key directly fails: it seals the content key.
    await expect(openSnapshot(snapshot, epoch2)).rejects.toThrow()

    const contentKey = await unwrapSnapshotKey(snapshot.wraps[0], epoch2)
    expect(toHex(await openSnapshot(snapshot, contentKey))).toBe(toHex(state("hello")))
  })

  it("comes with one wrap, under the epoch it was created in", async () => {
    const { snapshot } = await aSnapshot()
    expect(snapshot.wraps).toHaveLength(1)
    expect(snapshot.wraps[0].epoch).toBe(2)
    expect(snapshot.wraps[0].snapshotId).toBe(snapshot.id)
  })

  it("is different for every snapshot", async () => {
    const a = await aSnapshot()
    const b = await aSnapshot()
    const keyA = await unwrapSnapshotKey(a.snapshot.wraps[0], a.epoch2)
    const keyB = await unwrapSnapshotKey(b.snapshot.wraps[0], b.epoch2)
    expect(toHex(keyA)).not.toBe(toHex(keyB))
  })
})

describe("rewrapping for a new epoch", () => {
  /**
   * The whole saving: no document is opened, nothing is re-encrypted, and the
   * snapshot's own signature is untouched.
   */
  it("leaves the ciphertext, id and signature exactly as they were", async () => {
    const { snapshot, signingKey, author, epoch2 } = await aSnapshot()
    const epoch3 = generateAeadKey()

    const rewrapped = await rewrapSnapshot(snapshot, {
      fromEpochKey: epoch2,
      toEpoch: 3,
      toEpochKey: epoch3,
      signingKey,
      wrapper: author,
    })

    expect(rewrapped.ct).toBe(snapshot.ct)
    expect(rewrapped.sig).toBe(snapshot.sig)
    expect(rewrapped.id).toBe(snapshot.id)
    expect(await snapshotIdOf(rewrapped)).toBe(snapshot.id)
    expect(await verifySnapshot(rewrapped, signingKey.publicKey)).toBe(true)
  })

  it("makes it openable by a holder of the new epoch and nothing else", async () => {
    const { snapshot, signingKey, author, epoch2 } = await aSnapshot()
    const epoch3 = generateAeadKey()
    const unrelated = generateAeadKey()

    const rewrapped = await rewrapSnapshot(snapshot, {
      fromEpochKey: epoch2,
      toEpoch: 3,
      toEpochKey: epoch3,
      signingKey,
      wrapper: author,
    })

    // The joiner holds only epoch 3, and the snapshot was created under 2.
    const opened = await openSnapshotWith(rewrapped, keys({ 3: epoch3 }))
    expect(toHex(opened!)).toBe(toHex(state("hello")))

    // Someone holding an unrelated key gets nothing rather than an error.
    expect(await openSnapshotWith(rewrapped, keys({ 3: unrelated }))).toBeUndefined()
  })

  it("keeps the original wrap, so existing members do not lose access", async () => {
    const { snapshot, signingKey, author, epoch2 } = await aSnapshot()
    const epoch3 = generateAeadKey()

    const rewrapped = await rewrapSnapshot(snapshot, {
      fromEpochKey: epoch2,
      toEpoch: 3,
      toEpochKey: epoch3,
      signingKey,
      wrapper: author,
    })

    expect(rewrapped.wraps).toHaveLength(2)
    expect(await openSnapshotWith(rewrapped, keys({ 2: epoch2 }))).toBeDefined()
  })

  it("refuses to rewrap from a key that cannot open the existing wrap", async () => {
    const { snapshot, signingKey, author } = await aSnapshot()

    await expect(
      rewrapSnapshot(snapshot, {
        fromEpochKey: generateAeadKey(),
        toEpoch: 3,
        toEpochKey: generateAeadKey(),
        signingKey,
        wrapper: author,
      }),
    ).rejects.toThrow()
  })

  it("attributes each wrap to whoever produced it", async () => {
    const { snapshot, author, epoch2 } = await aSnapshot()
    const other = await generateSigningKey()

    const rewrapped = await rewrapSnapshot(snapshot, {
      fromEpochKey: epoch2,
      toEpoch: 3,
      toEpochKey: generateAeadKey(),
      signingKey: other,
      wrapper: didFromSigningKey(other.publicKey),
    })

    expect(await verifySnapshotWrap(rewrapped.wraps[1])).toBe(true)
    expect(rewrapped.wraps[1].wrapper).not.toBe(author)
    // A wrap claiming the wrong producer does not verify.
    expect(
      await verifySnapshotWrap({ ...rewrapped.wraps[1], wrapper: author }),
    ).toBe(false)
  })

  /** Bound to one snapshot, domain and epoch, so it cannot be lifted. */
  it("refuses a wrap moved to another epoch", async () => {
    const { snapshot, epoch2 } = await aSnapshot()
    const lifted = { ...snapshot.wraps[0], epoch: 9 }

    await expect(unwrapSnapshotKey(lifted, epoch2)).rejects.toThrow()
  })
})

describe("deciding which notes qualify", () => {
  /**
   * The check is metadata on both sides, so an admin can decide without opening
   * a single document. That is what makes the optimisation worth having.
   */
  it("qualifies a snapshot whose coverage equals the note's current state", async () => {
    const { snapshot } = await aSnapshot({ "did:key:zA": 3, "did:key:zB": 1 })

    expect(coversCurrentState(snapshot, { "did:key:zA": 3, "did:key:zB": 1 })).toBe(true)
  })

  /**
   * A snapshot lagging even one operation leaves a gap for that operation's
   * author, which is the deafness a joiner snapshot exists to prevent.
   */
  it("refuses one lagging a single operation", async () => {
    const { snapshot } = await aSnapshot({ "did:key:zA": 3 })

    expect(coversCurrentState(snapshot, { "did:key:zA": 4 })).toBe(false)
  })

  it("refuses one that has never seen an author at all", async () => {
    const { snapshot } = await aSnapshot({ "did:key:zA": 3 })

    expect(coversCurrentState(snapshot, { "did:key:zA": 3, "did:key:zNew": 1 })).toBe(false)
  })

  it("treats an absent author and a zero as the same thing", async () => {
    const { snapshot } = await aSnapshot({ "did:key:zA": 3 })

    expect(coversCurrentState(snapshot, { "did:key:zA": 3, "did:key:zB": 0 })).toBe(true)
  })
})

describe("selecting a wrap", () => {
  it("prefers the newest epoch the holder can reach", async () => {
    const { snapshot, signingKey, author, epoch2 } = await aSnapshot()
    const epoch3 = generateAeadKey()
    const rewrapped = await rewrapSnapshot(snapshot, {
      fromEpochKey: epoch2,
      toEpoch: 3,
      toEpochKey: epoch3,
      signingKey,
      wrapper: author,
    })

    const chosen = reachableWraps(rewrapped.wraps, rewrapped.id, [2, 3])
    expect(chosen[0].epoch).toBe(3)
  })

  it("ignores wraps for another snapshot", async () => {
    const a = await aSnapshot()
    const b = await aSnapshot()

    expect(reachableWraps(a.snapshot.wraps, b.snapshot.id, [2])).toEqual([])
  })
})

describe("a snapshot survives a round trip", () => {
  it("keeps its wraps through JSON", async () => {
    const { snapshot, epoch2 } = await aSnapshot()
    const revived = JSON.parse(JSON.stringify(snapshot)) as Snapshot

    const opened = await openSnapshotWith(revived, keys({ 2: epoch2 }))
    expect(toHex(opened!)).toBe(toHex(state("hello")))
  })
})
