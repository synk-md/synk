import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { unwrapSnapshotKey } from "./key-wrap"
import { generateSigningKey, toHex } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import { promoteNote, readKeysFor } from "@/lib/keys"
import { foundDomain, newMember, NOTEBOOK } from "@/test/key-fixtures"
import { createSnapshot, openSnapshot, verifySnapshot } from "./snapshot"
import { createPromotionSnapshot, supersededNotebookEpoch } from "./promotion"

function noteDoc(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = 11
  doc.getText("content").insert(0, text)
  return doc
}

describe("createPromotionSnapshot", () => {
  // The consumption of promotedAtNotebookEpoch, which M5 recorded but could not
  // use: it is what the snapshot records as superseded.
  it("carries note content into the note's own domain", async () => {
    const alice = await newMember("alice")
    const outsider = await newMember("outsider")
    const notebook = await foundDomain([alice])
    await notebook.admin.addMember(await newMember("bob"))

    const promotion = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: notebook.admin.currentEpoch },
      [alice, outsider],
    )
    expect(promotion.promotedAtNotebookEpoch).toBe(2)

    const signingKey = await generateSigningKey()
    const doc = noteDoc("shared note body")
    const snapshot = await createPromotionSnapshot({
      doc,
      signingKey,
      author: didFromSigningKey(signingKey.publicKey),
      promotion: { ...promotion, domain: promotion.admin.domain },
      resourceId: "note:abc",
      dek: await promotion.admin.currentKey(),
      covers: { "did:key:zAlice": 4 },
    })

    expect(snapshot.kind).toBe("promotion")
    expect(snapshot.domain).toBe("note:abc")
    expect(snapshot.epoch).toBe(1)
    expect(snapshot.parent).toBeNull()
    expect(snapshot.supersedesNotebookEpoch).toBe(2)
    expect(await verifySnapshot(snapshot, signingKey.publicKey)).toBe(true)
  })

  // The outsider gets the note's current content and nothing of the notebook.
  it("is readable by an outsider holding only the note's key", async () => {
    const alice = await newMember("alice")
    const outsider = await newMember("outsider")
    const notebook = await foundDomain([alice])

    const promotion = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: notebook.admin.currentEpoch },
      [alice, outsider],
    )
    const signingKey = await generateSigningKey()
    const doc = noteDoc("only this note")
    const snapshot = await createPromotionSnapshot({
      doc,
      signingKey,
      author: didFromSigningKey(signingKey.publicKey),
      promotion: { ...promotion, domain: promotion.admin.domain },
      resourceId: "note:abc",
      dek: await promotion.admin.currentKey(),
      covers: {},
    })

    const outsiderView = await readKeysFor(
      promotion.admin.timeline,
      promotion.sealed,
      outsider.sealingDid,
      outsider.sealingKey,
    )
    const state = await openSnapshot(
      snapshot,
      await unwrapSnapshotKey(snapshot.wraps[0], (await outsiderView.keyFor(1))!),
    )
    expect(toHex(state)).toBe(toHex(Y.encodeStateAsUpdate(doc)))

    // And the notebook remains closed to them.
    const notebookView = await readKeysFor(
      notebook.admin.timeline,
      notebook.keyring,
      outsider.sealingDid,
      outsider.sealingKey,
    )
    expect(notebookView.readableEpochs()).toEqual([])
  })

  it("re-establishes the note's authors for a reader", async () => {
    const alice = await newMember("alice")
    const notebook = await foundDomain([alice])
    const promotion = await promoteNote(
      "abc",
      { domain: NOTEBOOK, currentEpoch: notebook.admin.currentEpoch },
      [alice],
    )
    const signingKey = await generateSigningKey()
    const doc = noteDoc("content")
    const snapshot = await createPromotionSnapshot({
      doc,
      signingKey,
      author: didFromSigningKey(signingKey.publicKey),
      promotion: { ...promotion, domain: promotion.admin.domain },
      resourceId: "note:abc",
      dek: await promotion.admin.currentKey(),
      covers: {},
    })

    const reader = new Y.Doc()
    Y.applyUpdate(
      reader,
      await openSnapshot(
        snapshot,
        await unwrapSnapshotKey(snapshot.wraps[0], await promotion.admin.currentKey()),
      ),
    )
    expect(reader.getText("content").toJSON()).toBe("content")

    // A later edit from the note's original author places cleanly.
    const before = Y.encodeStateVector(doc)
    doc.getText("content").insert(doc.getText("content").length, " extended")
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(doc, before))
    expect(reader.getText("content").toJSON()).toBe("content extended")
  })
})

describe("supersededNotebookEpoch", () => {
  // Lets the interface say "history before sharing stays in the notebook"
  // rather than presenting an apparent gap.
  it("distinguishes intentionally unreachable history from missing history", async () => {
    const alice = await newMember("alice")
    const notebook = await foundDomain([alice])
    const promotion = await promoteNote("abc", { domain: NOTEBOOK, currentEpoch: 1 }, [alice])
    const signingKey = await generateSigningKey()

    const promoted = await createPromotionSnapshot({
      doc: noteDoc("x"),
      signingKey,
      author: didFromSigningKey(signingKey.publicKey),
      promotion: { ...promotion, domain: promotion.admin.domain },
      resourceId: "note:abc",
      dek: await promotion.admin.currentKey(),
      covers: {},
    })
    expect(supersededNotebookEpoch(promoted)).toBe(1)

    const ordinary = await createSnapshot({
      signingKey,
      author: didFromSigningKey(signingKey.publicKey),
      domain: NOTEBOOK,
      resourceId: NOTEBOOK,
      kind: "join",
      epoch: 1,
      dek: await notebook.admin.currentKey(),
      state: Y.encodeStateAsUpdate(noteDoc("y")),
      covers: {},
    })
    expect(supersededNotebookEpoch(ordinary)).toBeUndefined()
  })
})
