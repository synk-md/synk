import * as Y from "yjs"
import { beforeEach, describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey, type Bytes } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"
import {
  createSnapshot,
  openSnapshotWith,
  type Snapshot,
} from "@/lib/snapshots"

import { noteRefsFor, runNoteAdmission } from "./admit-notes"
import { keyDomainFor } from "./notebook-keys"
import { noteResourceId } from "./note-sync"

const T0 = 1_700_000_000_000
const NOTEBOOK = "travel"
const DOMAIN = keyDomainFor(NOTEBOOK)
const JOINER = "did:key:zAdaDevice"

const EPOCH_1: Bytes = new Uint8Array(32).fill(1)
const EPOCH_2: Bytes = new Uint8Array(32).fill(2)

beforeEach(() => {
  localStorage.clear()
})

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return {
    did: didFromSigningKey(signingKey.publicKey),
    clientId: record.clientId,
    signingKey,
    sealingKey,
    record,
  }
}

function aNote(text: string, client = 11): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = client
  if (text) doc.getText("body").insert(0, text)
  return doc
}

const keyFor = (_domain: string, epoch: number) =>
  Promise.resolve(epoch === 1 ? EPOCH_1 : epoch === 2 ? EPOCH_2 : undefined)

/** A keyring view holding only the joining epoch, as a joiner would. */
const joinerKeys = {
  keyFor: (epoch: number) => Promise.resolve(epoch === 2 ? EPOCH_2 : undefined),
  readableEpochs: () => [2],
}

interface Harness {
  owner: DeviceIdentity
  deposited: Snapshot[]
  notes: Map<string, Y.Doc>
}

async function harness(contents: Record<string, string>): Promise<Harness> {
  const owner = await aDevice()
  const notes = new Map(Object.entries(contents).map(([id, text]) => [id, aNote(text)]))
  return { owner, deposited: [], notes }
}

function run(h: Harness, options: { existing?: Snapshot[]; covers?: Record<string, number> } = {}) {
  return runNoteAdmission({
    notebookId: NOTEBOOK,
    joiner: JOINER,
    epochs: { [DOMAIN]: 2 },
    notes: noteRefsFor(NOTEBOOK, [...h.notes.keys()]),
    loadNote: (noteId) => Promise.resolve(h.notes.get(noteId)!),
    keyFor,
    signingKey: h.owner.signingKey,
    author: h.owner.did,
    ...(options.existing ? { existing: options.existing } : {}),
    ...(options.covers ? { coversFor: () => options.covers! } : {}),
    deposit: (snapshot) => {
      h.deposited.push(snapshot)
      return Promise.resolve()
    },
    now: T0,
  })
}

describe("covering a notebook for a joiner", () => {
  it("builds a snapshot the joiner can open, per note", async () => {
    const h = await harness({ kyoto: "notes on Kyoto", osaka: "notes on Osaka" })

    const result = await run(h)

    expect(result.built.sort()).toEqual(["kyoto", "osaka"])
    expect(h.deposited).toHaveLength(2)

    const kyoto = h.deposited.find(
      (s) => s.resourceId === noteResourceId(NOTEBOOK, "kyoto"),
    )!
    const state = await openSnapshotWith(kyoto, joinerKeys)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, state!)
    expect(restored.getText("body").toJSON()).toBe("notes on Kyoto")
  })

  /** No author means no gap, so there is nothing for a snapshot to close. */
  it("skips a note nobody has written to", async () => {
    const h = await harness({ empty: "", written: "something" })

    const result = await run(h)

    expect(result.skipped).toEqual(["empty"])
    expect(result.built).toEqual(["written"])
    expect(h.deposited).toHaveLength(1)
  })
})

describe("reusing what is already there", () => {
  /**
   * The reason this is affordable on a notebook where most notes are dormant:
   * no document is opened and nothing is re-encrypted.
   */
  it("rewraps a snapshot that already covers the note's current state", async () => {
    const h = await harness({ kyoto: "notes on Kyoto" })
    const covers = { "did:key:zAuthor": 4 }

    const existing = await createSnapshot({
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      domain: DOMAIN,
      resourceId: noteResourceId(NOTEBOOK, "kyoto"),
      kind: "automatic",
      epoch: 1,
      dek: EPOCH_1,
      state: Y.encodeStateAsUpdate(h.notes.get("kyoto")!),
      covers,
      createdAt: T0 - 1000,
    })

    let opened = 0
    const result = await runNoteAdmission({
      notebookId: NOTEBOOK,
      joiner: JOINER,
      epochs: { [DOMAIN]: 2 },
      notes: noteRefsFor(NOTEBOOK, ["kyoto"]),
      loadNote: (noteId) => {
        opened += 1
        return Promise.resolve(h.notes.get(noteId)!)
      },
      keyFor,
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      existing: [existing],
      coversFor: () => covers,
      deposit: (snapshot) => {
        h.deposited.push(snapshot)
        return Promise.resolve()
      },
      now: T0,
    })

    expect(result.rewrapped).toEqual(["kyoto"])
    expect(opened).toBe(0)

    const deposited = h.deposited[0]
    // Byte-identical content and signature; only the wrap list grew.
    expect(deposited.ct).toBe(existing.ct)
    expect(deposited.sig).toBe(existing.sig)
    expect(deposited.id).toBe(existing.id)
    expect(deposited.wraps).toHaveLength(2)

    // And the joiner, who holds only epoch 2, can open it.
    const state = await openSnapshotWith(deposited, joinerKeys)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, state!)
    expect(restored.getText("body").toJSON()).toBe("notes on Kyoto")
  })

  /**
   * A snapshot lagging one operation leaves a gap for that operation's author,
   * which is the deafness this exists to prevent.
   */
  it("builds fresh when the snapshot lags even one operation", async () => {
    const h = await harness({ kyoto: "notes on Kyoto" })

    const stale = await createSnapshot({
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      domain: DOMAIN,
      resourceId: noteResourceId(NOTEBOOK, "kyoto"),
      kind: "automatic",
      epoch: 1,
      dek: EPOCH_1,
      state: Y.encodeStateAsUpdate(h.notes.get("kyoto")!),
      covers: { "did:key:zAuthor": 3 },
      createdAt: T0 - 1000,
    })

    const result = await run(h, { existing: [stale], covers: { "did:key:zAuthor": 4 } })

    expect(result.rewrapped).toEqual([])
    expect(result.built).toEqual(["kyoto"])
  })

  it("ignores a snapshot belonging to another note", async () => {
    const h = await harness({ kyoto: "notes on Kyoto" })
    const covers = { "did:key:zAuthor": 1 }

    const elsewhere = await createSnapshot({
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      domain: DOMAIN,
      resourceId: noteResourceId(NOTEBOOK, "osaka"),
      kind: "automatic",
      epoch: 1,
      dek: EPOCH_1,
      state: Y.encodeStateAsUpdate(aNote("wrong note")),
      covers,
      createdAt: T0 - 1000,
    })

    const result = await run(h, { existing: [elsewhere], covers })

    expect(result.rewrapped).toEqual([])
    expect(result.built).toEqual(["kyoto"])
  })

  /** A missing key for the older epoch is a reason to rebuild, not to give up. */
  it("builds fresh when it cannot open the existing wrap", async () => {
    const h = await harness({ kyoto: "notes on Kyoto" })
    const covers = { "did:key:zAuthor": 1 }

    const unreachable = await createSnapshot({
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      domain: DOMAIN,
      resourceId: noteResourceId(NOTEBOOK, "kyoto"),
      kind: "automatic",
      epoch: 9,
      dek: new Uint8Array(32).fill(9),
      state: Y.encodeStateAsUpdate(h.notes.get("kyoto")!),
      covers,
      createdAt: T0 - 1000,
    })

    const result = await run(h, { existing: [unreachable], covers })

    expect(result.built).toEqual(["kyoto"])
    expect(h.deposited).toHaveLength(1)
  })
})

describe("resuming", () => {
  /** A tab closed halfway must not leave a member deaf to the rest. */
  it("finishes on a second run without redoing what landed", async () => {
    const h = await harness({ a: "one", b: "two", c: "three" })
    let failOnB = true

    const attempt = () =>
      runNoteAdmission({
        notebookId: NOTEBOOK,
        joiner: JOINER,
        epochs: { [DOMAIN]: 2 },
        notes: noteRefsFor(NOTEBOOK, ["a", "b", "c"]),
        loadNote: (noteId) => {
          if (noteId === "b" && failOnB) return Promise.reject(new Error("storage hiccup"))
          return Promise.resolve(h.notes.get(noteId)!)
        },
        keyFor,
        signingKey: h.owner.signingKey,
        author: h.owner.did,
        deposit: (snapshot) => {
          h.deposited.push(snapshot)
          return Promise.resolve()
        },
        now: T0,
      })

    const first = await attempt()
    expect(first.built.sort()).toEqual(["a", "c"])
    expect(h.deposited).toHaveLength(2)

    failOnB = false
    const second = await attempt()

    expect(second.built).toEqual(["b"])
    // "a" and "c" were not snapshotted twice.
    expect(h.deposited).toHaveLength(3)
  })

  it("reports progress per note", async () => {
    const h = await harness({ a: "one", b: "" })
    const seen: string[] = []

    await runNoteAdmission({
      notebookId: NOTEBOOK,
      joiner: JOINER,
      epochs: { [DOMAIN]: 2 },
      notes: noteRefsFor(NOTEBOOK, ["a", "b"]),
      loadNote: (noteId) => Promise.resolve(h.notes.get(noteId)!),
      keyFor,
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      deposit: () => Promise.resolve(),
      onProgress: (_progress, task, outcome) => {
        if (outcome) seen.push(`${task.noteId}:${outcome}`)
      },
      now: T0,
    })

    expect(seen).toEqual(["a:built", "b:skipped"])
  })
})

describe("promoted notes", () => {
  /** Its own timeline, so its own epoch and its own sealing. */
  it("names a promoted note's own key domain", () => {
    const refs = noteRefsFor(NOTEBOOK, ["plain", "promoted"], new Set(["promoted"]))

    expect(refs[0].domain).toBeUndefined()
    expect(refs[1].domain).toBe(`${DOMAIN}/note:promoted`)
  })

  it("refuses a note whose domain has no joining epoch", async () => {
    const h = await harness({ promoted: "content" })

    const result = await runNoteAdmission({
      notebookId: NOTEBOOK,
      joiner: JOINER,
      epochs: { [DOMAIN]: 2 },
      notes: noteRefsFor(NOTEBOOK, ["promoted"], new Set(["promoted"])),
      loadNote: (noteId) => Promise.resolve(h.notes.get(noteId)!),
      keyFor,
      signingKey: h.owner.signingKey,
      author: h.owner.did,
      deposit: () => Promise.resolve(),
      now: T0,
    })

    expect(result.built).toEqual([])
    expect(result.plan.tasks[0].state).toBe("failed")
    expect(result.plan.tasks[0].error).toMatch(/no joining epoch/)
  })
})
