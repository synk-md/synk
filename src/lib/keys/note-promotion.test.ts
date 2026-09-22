import { describe, expect, it } from "vitest"
import { toHex } from "@/lib/crypto"
import { foundDomain, newMember, NOTEBOOK } from "@/test/key-fixtures"
import { readKeysFor } from "./domain"
import {
  canReadPromotedNote,
  noteKeyDomain,
  notePromotionDomain,
  promoteNote,
} from "./note-promotion"

describe("noteKeyDomain", () => {
  it("is the notebook until promotion, then the note itself", () => {
    expect(noteKeyDomain(NOTEBOOK, "abc", false)).toBe(NOTEBOOK)
    expect(noteKeyDomain(NOTEBOOK, "abc", true)).toBe("note:abc")
    expect(notePromotionDomain("abc")).toBe("note:abc")
  })
})

describe("promoteNote", () => {
  // The point of promotion: share one note without handing over the notebook
  // key, which would unlock every other note.
  it("gives an outsider the note without the notebook", async () => {
    const alice = await newMember("alice")
    const outsider = await newMember("outsider")
    const notebook = await foundDomain([alice])

    const { admin: noteAdmin, sealed } = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: notebook.admin.currentEpoch },
      [alice, outsider],
      { createdAt: 5_000 },
    )

    // The outsider reads the note...
    const noteView = await readKeysFor(
      noteAdmin.timeline,
      sealed,
      outsider.sealingDid,
      outsider.sealingKey,
    )
    expect(noteView.readableEpochs()).toEqual([1])

    // ...and nothing in the notebook.
    const notebookView = await readKeysFor(
      notebook.admin.timeline,
      notebook.keyring,
      outsider.sealingDid,
      outsider.sealingKey,
    )
    expect(notebookView.readableEpochs()).toEqual([])
  })

  it("records where in the notebook's timeline the note left", async () => {
    const alice = await newMember("alice")
    const notebook = await foundDomain([alice])
    await notebook.admin.addMember(await newMember("bob"))

    const promoted = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: notebook.admin.currentEpoch },
      [alice],
    )
    expect(promoted.promotedAtNotebookEpoch).toBe(2)
    expect(promoted.admin.domain).toBe("note:abc")
    expect(promoted.admin.currentEpoch).toBe(1)
  })

  it("keys the note independently of the notebook", async () => {
    const alice = await newMember("alice")
    const notebook = await foundDomain([alice])
    const { admin: noteAdmin } = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: 1 },
      [alice],
    )
    expect(toHex(await noteAdmin.currentKey())).not.toBe(
      toHex(await notebook.admin.currentKey()),
    )
  })

  // Founders, not joiners: there is no earlier history in the new domain to
  // exclude anyone from.
  it("makes every initial reader a founder", async () => {
    const members = await Promise.all(["a", "b", "c"].map(newMember))
    const { sealed } = await promoteNote("abc", { domain: NOTEBOOK, currentEpoch: 1 }, members)
    expect(sealed).toHaveLength(3)
    expect(sealed.every((copy) => copy.epoch === 1)).toBe(true)
  })

  it("refuses a note nobody can read", async () => {
    await expect(
      promoteNote("abc", { domain: NOTEBOOK, currentEpoch: 1 }, []),
    ).rejects.toThrow(/at least one member/)
  })

  // Removal from a promoted note behaves like any other removal.
  it("can rotate an outsider back out", async () => {
    const alice = await newMember("alice")
    const outsider = await newMember("outsider")
    const { admin, sealed } = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: 1 },
      [alice, outsider],
    )
    const keyring = [...sealed, ...(await admin.removeMember([alice])).sealed]

    const outsiderView = await readKeysFor(
      admin.timeline,
      keyring,
      outsider.sealingDid,
      outsider.sealingKey,
    )
    expect(outsiderView.readableEpochs()).toEqual([1])
    expect(await outsiderView.keyFor(2)).toBeUndefined()
  })
})

describe("canReadPromotedNote", () => {
  it("answers for the note's own domain only", async () => {
    const alice = await newMember("alice")
    const stranger = await newMember("stranger")
    const { sealed } = await promoteNote("abc", { domain: NOTEBOOK, currentEpoch: 1 }, [alice])

    expect(await canReadPromotedNote("abc", sealed, alice.sealingDid, alice.sealingKey)).toBe(true)
    expect(
      await canReadPromotedNote("abc", sealed, stranger.sealingDid, stranger.sealingKey),
    ).toBe(false)
    expect(await canReadPromotedNote("other", sealed, alice.sealingDid, alice.sealingKey)).toBe(
      false,
    )
  })
})
