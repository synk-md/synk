import * as Y from "yjs"
import { describe, expect, it } from "vitest"

import { guardRecords } from "./guard"

const RECORDS = "directory:admissions"
const isRecords = (name: string) => name.startsWith("directory:")
const record = { did: "did:key:zAda", sig: "signed-by-the-owner" }

/** Two devices, exchanging whatever each writes, as a relay would carry it. */
function twoDevices() {
  const honest = new Y.Doc()
  const other = new Y.Doc()
  honest.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "wire") Y.applyUpdate(other, update, "wire")
  })
  other.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "wire") Y.applyUpdate(honest, update, "wire")
  })
  return { honest, other }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("putting back signed records", () => {
  it("puts back a record someone else deleted, for everyone", async () => {
    const { honest, other } = twoDevices()
    guardRecords(honest, isRecords)
    honest.getMap(RECORDS).set("slot", record)

    other.getMap(RECORDS).delete("slot")
    await settle()

    expect(honest.getMap(RECORDS).get("slot")).toEqual(record)
    expect(other.getMap(RECORDS).get("slot")).toEqual(record)
  })

  it("puts back a record someone else replaced", async () => {
    const { honest, other } = twoDevices()
    guardRecords(honest, isRecords)
    honest.getMap(RECORDS).set("slot", record)

    other.getMap(RECORDS).set("slot", { garbage: true })
    await settle()

    expect(other.getMap(RECORDS).get("slot")).toEqual(record)
  })

  it("leaves this device's own deletions alone", async () => {
    const { honest } = twoDevices()
    guardRecords(honest, isRecords)
    honest.getMap(RECORDS).set("slot", record)

    honest.getMap(RECORDS).delete("slot")
    await settle()

    expect(honest.getMap(RECORDS).has("slot")).toBe(false)
  })

  /** Both see the deletion and both put it back; that must settle, not go on forever. */
  it("settles when two devices put back the same record at once", async () => {
    const { honest, other } = twoDevices()
    const third = new Y.Doc()
    guardRecords(honest, isRecords)
    guardRecords(other, isRecords)
    honest.getMap(RECORDS).set("slot", record)

    Y.applyUpdate(third, Y.encodeStateAsUpdate(honest))
    third.getMap(RECORDS).delete("slot")
    const deletion = Y.encodeStateAsUpdate(third)
    let updates = 0
    honest.on("update", () => (updates += 1))
    Y.applyUpdate(honest, deletion, "wire")
    Y.applyUpdate(other, deletion, "wire")
    await settle()
    await settle()

    expect(honest.getMap(RECORDS).get("slot")).toEqual(record)
    expect(updates).toBeLessThan(10)
  })

  /** Join requests used to be kept as a list per invitation; adding to one replaces it. */
  it("leaves a value that is not a signed record to the merge", async () => {
    const { honest, other } = twoDevices()
    guardRecords(honest, isRecords)
    honest.getMap("directory:redemptions").set("invitation", [record])

    other.getMap("directory:redemptions").set("invitation", [record, { ...record, sig: "a-second-request" }])
    await settle()

    expect(honest.getMap("directory:redemptions").get("invitation")).toHaveLength(2)
  })

  it("does not guard what it is not asked to", async () => {
    const { honest, other } = twoDevices()
    guardRecords(honest, isRecords)
    honest.getMap("tree").set("node", { sig: "x" })

    other.getMap("tree").delete("node")
    await settle()

    expect(honest.getMap("tree").has("node")).toBe(false)
  })
})
