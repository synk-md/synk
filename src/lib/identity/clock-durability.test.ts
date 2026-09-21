import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { generateSigningKey } from "@/lib/crypto"
import { deriveClientId } from "./client-id"
import {
  assertClockDurability,
  attachDocumentClock,
  checkClockDurability,
  ClockRegressionError,
  currentDocumentClock,
  trackDocumentClock,
} from "./clock-durability"
import {
  clearClockWatermarks,
  loadClockWatermark,
  recordClockWatermark,
  resetDeviceDatabaseConnection,
} from "./device-store"

const DOC = "notebook:1"

async function newClientId(): Promise<number> {
  return deriveClientId((await generateSigningKey()).publicKey)
}

/** Let the tracker's queued IndexedDB writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  await clearClockWatermarks()
})

describe("currentDocumentClock", () => {
  it("reports the clock this device has reached", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    expect(currentDocumentClock(doc, clientId)).toBe(0)

    doc.getText("content").insert(0, "abc")
    expect(currentDocumentClock(doc, clientId)).toBe(3)
  })

  it("is zero for a client that has not authored", async () => {
    const doc = new Y.Doc()
    doc.getText("content").insert(0, "abc")
    expect(currentDocumentClock(doc, await newClientId())).toBe(0)
  })
})

describe("watermark persistence", () => {
  it("is monotonic - a lower value never lowers the mark", async () => {
    const clientId = await newClientId()
    await recordClockWatermark(DOC, clientId, 50)
    await recordClockWatermark(DOC, clientId, 10)
    expect((await loadClockWatermark(DOC))?.clock).toBe(50)

    await recordClockWatermark(DOC, clientId, 60)
    expect((await loadClockWatermark(DOC))?.clock).toBe(60)
  })

  it("keeps marks per document", async () => {
    const clientId = await newClientId()
    await recordClockWatermark("notebook:a", clientId, 5)
    await recordClockWatermark("notebook:b", clientId, 99)
    expect((await loadClockWatermark("notebook:a"))?.clock).toBe(5)
    expect((await loadClockWatermark("notebook:b"))?.clock).toBe(99)
  })

  // Yjs clocks are per document: one client id has independent sequences in
  // different notebooks. A device-global watermark would fire a false
  // regression the moment a second, less-edited document was opened.
  it("does not fire a false regression when opening a second document", async () => {
    const clientId = await newClientId()

    const busy = new Y.Doc()
    busy.clientID = clientId
    const stopBusy = await attachDocumentClock(busy, "notebook:busy", clientId)
    busy.getText("content").insert(0, "a".repeat(300))
    await settle()
    stopBusy()
    expect((await loadClockWatermark("notebook:busy"))?.clock).toBe(300)

    // A different notebook this device has barely touched. Its clock is far
    // below the other document's mark, and that must be fine.
    const quiet = new Y.Doc()
    quiet.clientID = clientId
    quiet.getText("content").insert(0, "ab")

    const status = await checkClockDurability(quiet, "notebook:quiet", clientId)
    expect(status.regressed).toBe(false)
    await expect(
      attachDocumentClock(quiet, "notebook:quiet", clientId),
    ).resolves.toBeTypeOf("function")
  })

  /**
   * Two tabs share one IndexedDB, so both run this read-modify-write against
   * the same row. The guard only survives because the get and the put live in
   * a single `readwrite` transaction - IndexedDB serialises overlapping
   * readwrite scopes, so no other writer can interleave between them. Splitting
   * them into two transactions would let a stale read overwrite a higher mark,
   * and this test is what catches that refactor.
   */
  it("holds the monotonic guard against a concurrent racing writer", async () => {
    const clientId = await newClientId()
    await Promise.all([
      recordClockWatermark(DOC, clientId, 100),
      recordClockWatermark(DOC, clientId, 5),
    ])
    expect((await loadClockWatermark(DOC))?.clock).toBe(100)
  })

  it("converges on the maximum under many interleaved writers", async () => {
    const clientId = await newClientId()
    const clocks = [17, 4, 250, 99, 3, 1000, 42, 7, 999, 1]
    await Promise.all(clocks.map((clock) => recordClockWatermark(DOC, clientId, clock)))
    expect((await loadClockWatermark(DOC))?.clock).toBe(Math.max(...clocks))
  })

  // The clock must be as durable as the key, so it lives in the same database
  // and survives the same reconnect the identity does.
  it("survives a dropped database connection", async () => {
    const clientId = await newClientId()
    await recordClockWatermark(DOC, clientId, 42)
    resetDeviceDatabaseConnection()
    expect((await loadClockWatermark(DOC))?.clock).toBe(42)
  })
})

describe("trackDocumentClock", () => {
  it("advances the mark as the device authors", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    const stop = trackDocumentClock(doc, DOC, clientId)

    doc.getText("content").insert(0, "hello")
    await settle()
    expect((await loadClockWatermark(DOC))?.clock).toBe(5)

    doc.getText("content").insert(5, " world")
    await settle()
    expect((await loadClockWatermark(DOC))?.clock).toBe(11)

    stop()
  })

  // Remote updates carry another device's client id and must not cost a write.
  it("ignores remote updates", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    const stop = trackDocumentClock(doc, DOC, clientId)

    const peer = new Y.Doc()
    peer.getText("content").insert(0, "from elsewhere")
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    await settle()

    expect(await loadClockWatermark(DOC)).toBeUndefined()
    stop()
  })

  it("stops writing once unsubscribed", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    const stop = trackDocumentClock(doc, DOC, clientId)

    doc.getText("content").insert(0, "abc")
    await settle()
    stop()

    doc.getText("content").insert(3, "defgh")
    await settle()
    expect((await loadClockWatermark(DOC))?.clock).toBe(3)
  })

  it("reports write failures without breaking editing", async () => {
    const doc = new Y.Doc()
    const onError = vi.fn()
    // A function is not structured-cloneable, so the IndexedDB put aborts the
    // transaction. Cast because the type system rightly forbids this - the
    // point is to exercise the rejection path, not a reachable API misuse.
    const uncloneable = (() => undefined) as unknown as number
    const stop = trackDocumentClock(doc, DOC, uncloneable, { onError })

    expect(() => doc.getText("content").insert(0, "still editable")).not.toThrow()
    await settle()

    // Editing survived, and the failure was surfaced rather than swallowed.
    expect(doc.getText("content").toJSON()).toBe("still editable")
    expect(onError).toHaveBeenCalled()
    stop()
  })
})

describe("checkClockDurability", () => {
  it("reports agreement when the document is at or ahead of the mark", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    doc.getText("content").insert(0, "abcde")
    await recordClockWatermark(DOC, clientId, 5)

    const status = await checkClockDurability(doc, DOC, clientId)
    expect(status).toMatchObject({ storedClock: 5, observedClock: 5, regressed: false })
  })

  it("reports no regression when nothing was ever recorded", async () => {
    const clientId = await newClientId()
    const status = await checkClockDurability(new Y.Doc(), DOC, clientId)
    expect(status.regressed).toBe(false)
  })
})

describe("regression detection", () => {
  // The failure this whole module exists to catch: document store wiped, key
  // store intact, device about to reissue (client, clock) pairs.
  it("detects document-state loss while the identity survives", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    const stop = trackDocumentClock(doc, DOC, clientId)
    doc.getText("content").insert(0, "a lot of authored content")
    await settle()
    stop()

    // Document store lost; identity and clock mark survive.
    const fresh = new Y.Doc()
    fresh.clientID = clientId

    const status = await checkClockDurability(fresh, DOC, clientId)
    expect(status.regressed).toBe(true)
    expect(status.observedClock).toBe(0)
    expect(status.storedClock).toBe(25)

    await expect(assertClockDurability(fresh, DOC, clientId)).rejects.toBeInstanceOf(
      ClockRegressionError,
    )
  })

  it("carries the detail needed to choose a remedy", async () => {
    const clientId = await newClientId()
    await recordClockWatermark(DOC, clientId, 120)
    const fresh = new Y.Doc()

    const error = await assertClockDurability(fresh, DOC, clientId).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClockRegressionError)
    const regression = error as ClockRegressionError
    expect(regression.docId).toBe(DOC)
    expect(regression.clientId).toBe(clientId)
    expect(regression.storedClock).toBe(120)
    expect(regression.observedClock).toBe(0)
    expect(regression.message).toMatch(/re-admission required/)
  })

  it("does not fire when the document is merely ahead", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    doc.clientID = clientId
    doc.getText("content").insert(0, "abcdefghij")
    await recordClockWatermark(DOC, clientId, 3) // mark lagging behind
    await expect(assertClockDurability(doc, DOC, clientId)).resolves.toBeUndefined()
  })
})

describe("attachDocumentClock", () => {
  it("pins the client id, records the mark, and tracks onward", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()

    const stop = await attachDocumentClock(doc, DOC, clientId)
    expect(doc.clientID).toBe(clientId)

    doc.getText("content").insert(0, "authored")
    await settle()
    expect((await loadClockWatermark(DOC))?.clock).toBe(8)
    stop()
  })

  // Order matters: a document that failed the check must never be left carrying
  // this device's client id, or a later careless write would corrupt it.
  it("refuses to pin a regressed document", async () => {
    const clientId = await newClientId()
    await recordClockWatermark(DOC, clientId, 500)

    const doc = new Y.Doc()
    const before = doc.clientID

    await expect(attachDocumentClock(doc, DOC, clientId)).rejects.toBeInstanceOf(
      ClockRegressionError,
    )
    expect(doc.clientID).toBe(before)
    expect(doc.clientID).not.toBe(clientId)
  })

  it("is safe across a simulated reload with state intact", async () => {
    const clientId = await newClientId()
    const doc = new Y.Doc()
    const stop = await attachDocumentClock(doc, DOC, clientId)
    doc.getText("content").insert(0, "session one")
    await settle()
    stop()

    const persisted = Y.encodeStateAsUpdate(doc)
    resetDeviceDatabaseConnection()

    // Reload: document state restored from its own store before authoring.
    const reloaded = new Y.Doc()
    Y.applyUpdate(reloaded, persisted)
    const stop2 = await attachDocumentClock(reloaded, DOC, clientId)

    expect(reloaded.clientID).toBe(clientId)
    reloaded.getText("content").insert(11, " session two")
    await settle()
    expect((await loadClockWatermark(DOC))?.clock).toBe(23)
    stop2()
  })
})
