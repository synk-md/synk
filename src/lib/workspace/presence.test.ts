import { describe, expect, it } from "vitest"

import { generateAeadKey } from "@/lib/crypto"

import { indexPresenceScope, notePresenceScope, presenceRoom } from "./presence"

describe("presence rooms", () => {
  it("are the same for everyone holding the same key", async () => {
    const key = generateAeadKey()
    expect(await presenceRoom(key, "index:travel")).toEqual(await presenceRoom(key, "index:travel"))
  })

  /** A new epoch is a new room: whoever was cut off is left in the old one. */
  it("move when the key does", async () => {
    const before = await presenceRoom(generateAeadKey(), "index:travel")
    const after = await presenceRoom(generateAeadKey(), "index:travel")
    expect(after.name).not.toBe(before.name)
    expect(after.password).not.toBe(before.password)
  })

  it("keep one note's cursors apart from another's", async () => {
    const key = generateAeadKey()
    const kyoto = await presenceRoom(key, notePresenceScope("travel", "kyoto"))
    const osaka = await presenceRoom(key, notePresenceScope("travel", "osaka"))
    expect(kyoto.name).not.toBe(osaka.name)
  })

  /** The signaling server sees the name. It should learn nothing from it. */
  it("name nothing the signaling server could recognise", async () => {
    const room = await presenceRoom(generateAeadKey(), indexPresenceScope("travel"))
    expect(room.name).not.toContain("travel")
    expect(room.password).not.toBe(room.name)
  })
})
