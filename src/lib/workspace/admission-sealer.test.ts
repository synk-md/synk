import * as Y from "yjs"
import { describe, expect, it, vi } from "vitest"

import { generateAeadKey, generateSigningKey, toHex } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import { openSnapshotWith, verifySnapshot } from "@/lib/snapshots"

import { createSealer, inlineSealer, workerSealer } from "./admission-sealer"

const T0 = 1_700_000_000_000
const DOMAIN = "notebook:travel"
const RESOURCE = "notebook:travel/note:kyoto"

function state(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 9
  doc.getText("body").insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

async function sealer() {
  const signingKey = await generateSigningKey()
  const author = didFromSigningKey(signingKey.publicKey)
  return { signingKey, author, sealer: inlineSealer(signingKey, author) }
}

describe("sealing in place", () => {
  it("produces a snapshot the holder of that epoch can open", async () => {
    const { signingKey, sealer: seal } = await sealer()
    const epochKey = generateAeadKey()

    const snapshot = await seal.seal({
      domain: DOMAIN,
      resourceId: RESOURCE,
      epoch: 2,
      epochKey,
      state: state("notes on Kyoto"),
      covers: { "did:key:zA": 1 },
      createdAt: T0,
    })

    expect(await verifySnapshot(snapshot, signingKey.publicKey)).toBe(true)
    const opened = await openSnapshotWith(snapshot, {
      keyFor: (epoch) => Promise.resolve(epoch === 2 ? epochKey : undefined),
      readableEpochs: () => [2],
    })
    expect(toHex(opened!)).toBe(toHex(state("notes on Kyoto")))
  })

  it("rewraps without changing the snapshot", async () => {
    const { sealer: seal } = await sealer()
    const first = generateAeadKey()
    const second = generateAeadKey()

    const original = await seal.seal({
      domain: DOMAIN,
      resourceId: RESOURCE,
      epoch: 1,
      epochKey: first,
      state: state("unchanged"),
      covers: {},
      createdAt: T0,
    })
    const rewrapped = await seal.rewrap({
      snapshot: original,
      fromEpochKey: first,
      toEpoch: 2,
      toEpochKey: second,
      createdAt: T0 + 1,
    })

    expect(rewrapped.ct).toBe(original.ct)
    expect(rewrapped.id).toBe(original.id)
    expect(rewrapped.wraps).toHaveLength(2)
  })

  it("says it is not off the main thread", async () => {
    const { sealer: seal } = await sealer()
    expect(seal.offThread).toBe(false)
  })
})

describe("choosing a sealer", () => {
  /** A missing Worker should make admission slower, not impossible. */
  it("falls back in place when workers are unavailable", async () => {
    const signingKey = await generateSigningKey()
    const original = globalThis.Worker
    // @ts-expect-error removing a global for the duration of this test
    delete globalThis.Worker
    try {
      const chosen = createSealer(signingKey, didFromSigningKey(signingKey.publicKey))
      expect(chosen.offThread).toBe(false)
    } finally {
      globalThis.Worker = original
    }
  })

  it("falls back when constructing the worker throws", async () => {
    const signingKey = await generateSigningKey()
    const stored = signingKey.toStorable()
    const original = globalThis.Worker
    globalThis.Worker = class {
      constructor() {
        throw new Error("blocked by policy")
      }
    } as unknown as typeof Worker
    try {
      expect(workerSealer(stored, "did:key:zA")).toBeNull()
    } finally {
      globalThis.Worker = original
    }
  })
})

describe("the worker sealer", () => {
  /** One failure takes the worker down, so nothing may be left hanging. */
  it("fails everything in flight when the worker errors", async () => {
    const signingKey = await generateSigningKey()
    const stored = signingKey.toStorable()
    const posted: unknown[] = []
    let onerror: (() => void) | undefined

    globalThis.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      set onerror(handler: () => void) {
        onerror = handler
      }
      postMessage(data: unknown) {
        posted.push(data)
      }
      terminate() {
        /* nothing to release */
      }
    } as unknown as typeof Worker

    try {
      const seal = workerSealer(stored, "did:key:zA")!
      expect(seal.offThread).toBe(true)

      const pending = seal.seal({
        domain: DOMAIN,
        resourceId: RESOURCE,
        epoch: 2,
        epochKey: generateAeadKey(),
        state: state("x"),
        covers: {},
        createdAt: T0,
      })
      expect(posted).toHaveLength(1)

      onerror?.()
      await expect(pending).rejects.toThrow(/worker failed/)
    } finally {
      // @ts-expect-error restoring the real global
      delete globalThis.Worker
    }
  })

  it("rejects what is outstanding when closed", async () => {
    const signingKey = await generateSigningKey()
    globalThis.Worker = class {
      onmessage = null
      onerror = null
      postMessage() {
        /* never answers */
      }
      terminate = vi.fn()
    } as unknown as typeof Worker

    try {
      const seal = workerSealer(signingKey.toStorable(), "did:key:zA")!
      const pending = seal.rewrap({
        snapshot: { id: "s", wraps: [] } as never,
        fromEpochKey: generateAeadKey(),
        toEpoch: 2,
        toEpochKey: generateAeadKey(),
        createdAt: T0,
      })
      seal.close()
      await expect(pending).rejects.toThrow(/closed/)
    } finally {
      // @ts-expect-error restoring the real global
      delete globalThis.Worker
    }
  })
})
