import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import {
  checkUpdateAuthorship,
  updateDeleteSetClientIds,
  updateStructClientIds,
} from "./update-guard"

const ALICE = 1111
const BOB = 2222

function authored(clientId: number, text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = clientId
  doc.getText("t").insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

describe("updateStructClientIds", () => {
  it("reports the authoring client", () => {
    expect(updateStructClientIds(authored(ALICE, "hello"))).toEqual([ALICE])
  })

  it("reports every client in a merged update", () => {
    const alice = new Y.Doc()
    alice.clientID = ALICE
    alice.getText("t").insert(0, "a")
    const bob = new Y.Doc()
    bob.clientID = BOB
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    bob.getText("t").insert(1, "b")

    expect(updateStructClientIds(Y.encodeStateAsUpdate(bob)).sort()).toEqual([ALICE, BOB])
  })

  it("is empty for an update with no insertions", () => {
    const doc = new Y.Doc()
    doc.clientID = ALICE
    expect(updateStructClientIds(Y.encodeStateAsUpdate(doc))).toEqual([])
  })
})

describe("checkUpdateAuthorship", () => {
  it("accepts an update authored by the expected client", () => {
    expect(checkUpdateAuthorship(authored(ALICE, "mine"), ALICE)).toEqual({ ok: true, foreign: [] })
  })

  // The forgery this exists to stop: operations carrying someone else's client
  // id, which would attribute the edit to them.
  it("rejects operations claiming another client id", () => {
    const result = checkUpdateAuthorship(authored(BOB, "not mine"), ALICE)
    expect(result.ok).toBe(false)
    expect(result.foreign).toEqual([BOB])
  })

  it("rejects an update mixing the author with a foreign client", () => {
    const alice = new Y.Doc()
    alice.clientID = ALICE
    alice.getText("t").insert(0, "a")
    const bob = new Y.Doc()
    bob.clientID = BOB
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    bob.getText("t").insert(1, "b")

    const result = checkUpdateAuthorship(Y.encodeStateAsUpdate(bob), BOB)
    expect(result.ok).toBe(false)
    expect(result.foreign).toEqual([ALICE])
  })

  // A delete set legitimately names whoever created the deleted items, so a
  // delete-only update carries no structs and must pass.
  it("accepts a delete-only update of another author's content", () => {
    const alice = new Y.Doc()
    alice.clientID = ALICE
    alice.getText("t").insert(0, "delete me")

    const bob = new Y.Doc()
    bob.clientID = BOB
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    const before = Y.encodeStateVector(bob)
    bob.getText("t").delete(0, 7)
    const deleteOnly = Y.encodeStateAsUpdate(bob, before)

    expect(updateStructClientIds(deleteOnly)).toEqual([])
    expect(updateDeleteSetClientIds(deleteOnly)).toEqual([ALICE])
    expect(checkUpdateAuthorship(deleteOnly, BOB).ok).toBe(true)
  })

  it("treats a malformed update as a rejection rather than throwing", () => {
    expect(() => checkUpdateAuthorship(new Uint8Array([1, 2, 3, 4, 5]), ALICE)).not.toThrow()
    expect(checkUpdateAuthorship(new Uint8Array([255, 255, 255]), ALICE).ok).toBe(false)
  })
})
