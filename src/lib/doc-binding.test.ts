import * as Y from "yjs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearClockWatermarks,
  deriveClientId,
  initCurrentDevice,
  loadClockWatermark,
  recordClockWatermark,
  resetCurrentDevice,
  resetDeviceIdentityCache,
  type CurrentDevice,
} from "@/lib/identity"

import { bindDoc } from "./doc-binding"

const DOC_ID = "nb:travel:n:kyoto"

/** Web Locks is absent in jsdom, so leadership is modelled explicitly. */
function lockBackend() {
  const held = new Set<string>()
  return {
    backend: {
      acquire: (name: string) => {
        if (held.has(name)) return Promise.resolve(null)
        held.add(name)
        return Promise.resolve(() => held.delete(name))
      },
    },
    held,
  }
}

let device: CurrentDevice | null

beforeEach(async () => {
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await clearClockWatermarks()
  device = await initCurrentDevice()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("bindDoc", () => {
  it("pins the derived client id before anything can be typed", () => {
    const doc = new Y.Doc()
    const random = doc.clientID

    bindDoc(doc, DOC_ID, Promise.resolve())

    // Synchronous, not after an await: the first keystroke has to be
    // attributable or no peer will accept it.
    expect(doc.clientID).not.toBe(random)
    expect(doc.clientID).toBe(device?.clientId)
  })

  it("derives the same id the identity layer would", async () => {
    const doc = new Y.Doc()
    bindDoc(doc, DOC_ID, Promise.resolve())

    expect(doc.clientID).toBe(await deriveClientId(device!.identity.signingKey.publicKey))
  })

  it("reports a writer once storage has loaded", async () => {
    const doc = new Y.Doc()
    const bound = bindDoc(doc, DOC_ID, Promise.resolve())

    const binding = await bound.binding
    expect(binding.status).toBe("writer")
    expect(binding.clientId).toBe(device?.clientId)
    bound.release()
  })

  it("records a watermark as the document is written", async () => {
    const doc = new Y.Doc()
    const bound = bindDoc(doc, DOC_ID, Promise.resolve())
    await bound.binding

    doc.getText("body").insert(0, "hello")
    await vi.waitFor(async () => {
      expect((await loadClockWatermark(DOC_ID))?.clock).toBeGreaterThan(0)
    })
    bound.release()
  })

  /**
   * The direct consequence of pinning. Yjs gives each tab a random id, so two
   * tabs never collided before; a derived id is the same in both.
   */
  it("makes the second tab a follower rather than letting both write", async () => {
    const { backend } = lockBackend()

    const first = bindDoc(new Y.Doc(), DOC_ID, Promise.resolve(), { lockBackend: backend })
    const second = bindDoc(new Y.Doc(), DOC_ID, Promise.resolve(), { lockBackend: backend })

    expect((await first.binding).status).toBe("writer")
    expect((await second.binding).status).toBe("follower")
    expect((await second.binding).detail).toMatch(/another tab/)

    first.release()
    second.release()
  })

  it("lets the next tab write once the first releases", async () => {
    const { backend } = lockBackend()

    const first = bindDoc(new Y.Doc(), DOC_ID, Promise.resolve(), { lockBackend: backend })
    await first.binding
    first.release()

    const second = bindDoc(new Y.Doc(), DOC_ID, Promise.resolve(), { lockBackend: backend })
    expect((await second.binding).status).toBe("writer")
    second.release()
  })

  /**
   * The document is behind what this device already published, so reusing the
   * ids in between would be silent corruption.
   */
  it("refuses to write when the clock has rewound", async () => {
    await recordClockWatermark(DOC_ID, device!.clientId, 50)

    const doc = new Y.Doc()
    const bound = bindDoc(doc, DOC_ID, Promise.resolve())
    const binding = await bound.binding

    expect(binding.status).toBe("regressed")
    expect(binding.clock?.storedClock).toBe(50)
    expect(binding.clock?.observedClock).toBe(0)
    expect(binding.detail).toMatch(/reuse operation ids/)
    bound.release()
  })

  /**
   * An empty document looks exactly like a rewound one, so the check has to
   * wait for storage. Checking early would report a regression on every open.
   */
  it("waits for storage before judging the clock", async () => {
    const doc = new Y.Doc()
    doc.clientID = device!.clientId
    doc.getText("body").insert(0, "loaded from storage")
    await recordClockWatermark(DOC_ID, device!.clientId, 1)

    let release = () => undefined as void
    const storage = new Promise<void>((resolve) => {
      release = resolve
    })

    const empty = new Y.Doc()
    const bound = bindDoc(empty, DOC_ID, storage)

    // Nothing has been judged yet.
    expect(bound.current().status).toBe("writer")

    Y.applyUpdate(empty, Y.encodeStateAsUpdate(doc))
    release()

    expect((await bound.binding).status).toBe("writer")
    bound.release()
  })

  it("still allows local editing when there is no device identity", async () => {
    resetCurrentDevice()
    const doc = new Y.Doc()
    const random = doc.clientID

    const bound = bindDoc(doc, DOC_ID, Promise.resolve())
    const binding = await bound.binding

    // Left alone rather than pinned, and not blocked: editing locally never
    // depended on having an identity.
    expect(doc.clientID).toBe(random)
    expect(binding.status).toBe("unidentified")
    expect(binding.clientId).toBeNull()
  })

  it("stops tracking once released", async () => {
    const doc = new Y.Doc()
    const bound = bindDoc(doc, DOC_ID, Promise.resolve())
    await bound.binding

    doc.getText("body").insert(0, "one")
    await vi.waitFor(async () => {
      expect((await loadClockWatermark(DOC_ID))?.clock).toBeGreaterThan(0)
    })
    const at = (await loadClockWatermark(DOC_ID))!.clock

    bound.release()
    doc.getText("body").insert(0, "two")
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect((await loadClockWatermark(DOC_ID))?.clock).toBe(at)
  })
})
