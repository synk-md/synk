import { describe, expect, it } from "vitest"

import { generateSigningKey, type SigningKey } from "@/lib/crypto"
import { didFromSigningKey } from "@/lib/identity"
import {
  KeyDomainAdmin,
  notePromotionDomain,
  readKeysFor,
  type FlatKeyring,
  type SealedEpochKey,
} from "@/lib/keys"
import { newMember } from "@/test/key-fixtures"
import type { Envelope } from "@/lib/sync"
import type { SnapshotEntry } from "@/lib/snapshots"

import { applyErasure, eraseDomain, eraseHistory, eraseNote, noteErasability } from "./erase"
import { assessErasure, ErasureRefused, requireClean } from "./impact"
import { erasureScope, nextCleanBoundary, prefixTargets } from "./scope"
import { erasureProgress, orderErasure, verifyErasure } from "./tombstone"

const T0 = 1_700_000_000_000
const DOMAIN = "notebook:travel"
const RESOURCE = "notebook:travel"

interface Admin {
  signingKey: SigningKey
  did: string
}

async function admin(): Promise<Admin> {
  const signingKey = await generateSigningKey()
  return { signingKey, did: didFromSigningKey(signingKey.publicKey) }
}

/**
 * A domain with a real epoch history: genesis, two joins (chained), a removal
 * (fresh seed), then another join. Segments are 1-3 and 4-5.
 */
async function aDomain(): Promise<{ domain: KeyDomainAdmin; keyring: FlatKeyring }> {
  const ada = await newMember("ada")
  const bob = await newMember("bob")
  const { admin: domain, sealed: genesis } = await KeyDomainAdmin.create(DOMAIN, [ada], {
    createdAt: T0,
  })

  const sealed: SealedEpochKey[] = [...genesis]
  // 2 and 3 are chained joins, 4 is a removal with a fresh seed, 5 is chained.
  sealed.push(...(await domain.addMember(bob, { createdAt: T0 + 1 })).sealed)
  sealed.push(...(await domain.addMember(bob, { createdAt: T0 + 2 })).sealed)
  sealed.push(...(await domain.removeMember([ada], { createdAt: T0 + 3 })).sealed)
  sealed.push(...(await domain.addMember(bob, { createdAt: T0 + 4 })).sealed)

  const keyring = await readKeysFor(domain.timeline, sealed, ada.sealingDid, ada.sealingKey)
  return { domain, keyring }
}

function anEnvelope(epoch: number, seq: number): Pick<Envelope, "author" | "seq" | "epoch"> {
  return { author: "did:key:zAuthor", seq, epoch }
}

function aSnapshot(id: string, epoch: number, materialised = true): SnapshotEntry {
  const base = {
    id,
    domain: DOMAIN,
    resourceId: RESOURCE,
    kind: "automatic" as const,
    author: "did:key:zAuthor",
    epoch,
    covers: {},
    parent: null,
    stateHash: "hash",
    createdAt: T0 + epoch,
  }
  return materialised
    ? ({ materialised: true, ...base } as unknown as SnapshotEntry)
    : ({ materialised: false, ...base } as SnapshotEntry)
}

/* ---- scope --------------------------------------------------------------- */

describe("erasureScope", () => {
  /**
   * The central fact. The chain runs forward inside a segment, so erasing an
   * epoch means erasing every anchor that reaches it - and everything else
   * those anchors reached.
   */
  it("takes earlier epochs of the same segment with it", async () => {
    const { domain } = await aDomain()
    // Holding the genesis anchor alone reaches epochs 1-3.
    const scope = erasureScope(domain.timeline, [1], [3])

    expect(scope.anchors).toEqual([1])
    expect(scope.epochs).toEqual([1, 2, 3])
    expect(scope.collateral).toEqual([1, 2])
    expect(scope.clean).toBe(false)
  })

  it("does not reach across a rotation", async () => {
    const { domain } = await aDomain()
    // Epoch 4 is a fresh seed, so the genesis anchor cannot derive it.
    const scope = erasureScope(domain.timeline, [1, 4], [3])

    expect(scope.epochs).toEqual([1, 2, 3])
    expect(scope.epochs).not.toContain(4)
  })

  it("is clean when the target is a whole prefix", async () => {
    const { domain } = await aDomain()
    const scope = erasureScope(domain.timeline, [1, 4], prefixTargets(3))

    expect(scope.clean).toBe(true)
    expect(scope.collateral).toEqual([])
  })

  /** Two members of the same notebook hold different anchors and lose differently. */
  it("depends on which anchors the holder actually has", async () => {
    const { domain } = await aDomain()

    const early = erasureScope(domain.timeline, [1], [3])
    const late = erasureScope(domain.timeline, [3], [3])

    expect(early.collateral).toEqual([1, 2])
    expect(late.collateral).toEqual([])
  })

  it("offers the next boundary where erasing costs nothing extra", async () => {
    const { domain } = await aDomain()
    expect(nextCleanBoundary(domain.timeline, 2)).toBe(4)
    expect(nextCleanBoundary(domain.timeline, 6)).toBeNull()
  })
})

/* ---- impact -------------------------------------------------------------- */

describe("assessErasure", () => {
  it("counts what stops being readable", async () => {
    const { domain, keyring } = await aDomain()

    const impact = assessErasure({
      timeline: domain.timeline,
      heldAnchors: keyring.anchorEpochs,
      targets: prefixTargets(3),
      envelopes: [anEnvelope(1, 1), anEnvelope(3, 2), anEnvelope(5, 3)],
      snapshots: [aSnapshot("old", 2), aSnapshot("new", 5)],
    })

    expect(impact.envelopesOrphaned).toBe(2)
    expect(impact.snapshotsOrphaned).toEqual(["old"])
    expect(impact.preservedBy).toBe("new")
    expect(impact.contentLost).toBe(false)
  })

  /** A marker proves the timeline, not the content, so it preserves nothing. */
  it("does not treat a degraded marker as preserving the content", async () => {
    const { domain, keyring } = await aDomain()

    const impact = assessErasure({
      timeline: domain.timeline,
      heldAnchors: keyring.anchorEpochs,
      targets: prefixTargets(3),
      snapshots: [aSnapshot("kept", 5, false)],
    })

    expect(impact.preservedBy).toBeNull()
    expect(impact.contentLost).toBe(true)
  })

  it("refuses an erasure that reaches further than asked, when told to", async () => {
    const { domain, keyring } = await aDomain()
    const impact = assessErasure({
      timeline: domain.timeline,
      heldAnchors: keyring.anchorEpochs,
      targets: [3],
    })

    expect(() => requireClean(impact)).toThrow(ErasureRefused)
  })
})

/* ---- the order ----------------------------------------------------------- */

describe("the erasure order", () => {
  it("verifies from an admin and not from anyone else", async () => {
    const boss = await admin()
    const stranger = await admin()
    const record = await orderErasure({
      signingKey: boss.signingKey,
      issuer: boss.did,
      domain: DOMAIN,
      resourceId: RESOURCE,
      scope: "domain",
      throughEpoch: 5,
      issuedAt: T0,
    })

    expect(await verifyErasure(record, [boss.did])).toBe(true)
    expect(await verifyErasure(record, [stranger.did])).toBe(false)
  })

  /** One record that asks everyone to destroy irreversibly. Forgery is a DoS. */
  it("refuses a tampered order", async () => {
    const boss = await admin()
    const record = await orderErasure({
      signingKey: boss.signingKey,
      issuer: boss.did,
      domain: DOMAIN,
      resourceId: RESOURCE,
      scope: "history",
      throughEpoch: 2,
      preservedBy: "snap",
      issuedAt: T0,
    })

    expect(await verifyErasure({ ...record, throughEpoch: 5 }, [boss.did])).toBe(false)
    expect(await verifyErasure({ ...record, preservedBy: null }, [boss.did])).toBe(false)
  })

  it("will not claim completeness while a holder has not confirmed", () => {
    const progress = erasureProgress("workspace", ["ada", "bob"], ["ada"])

    expect(progress.complete).toBe(false)
    expect(progress.outstanding).toEqual(["bob"])
    expect(erasureProgress("workspace", ["ada"], ["ada"]).complete).toBe(true)
  })
})

/* ---- deleting a notebook ------------------------------------------------- */

describe("eraseDomain", () => {
  it("makes every epoch unreadable", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()
    expect(keyring.readableEpochs().length).toBeGreaterThan(0)

    const outcome = await eraseDomain({
      keyring: keyring,
      resourceId: RESOURCE,
      admin: boss,
      now: T0,
    })

    expect(keyring.readableEpochs()).toEqual([])
    expect(await keyring.keyFor(1)).toBeUndefined()
    expect(await keyring.keyFor(5)).toBeUndefined()
    expect(outcome.record.scope).toBe("domain")
    // Leaving nothing readable is the intent here, not an accident.
    expect(outcome.impact.contentLost).toBe(true)
  })

  /**
   * The subtle one. The sealed copies are still on the relay, so a keyring that
   * simply dropped its anchors would get them back on the next sync and quietly
   * undo the erasure.
   */
  it("survives a refresh that re-offers the destroyed keys", async () => {
    const boss = await admin()
    const ada = await newMember("ada")
    const { admin: domain, sealed } = await KeyDomainAdmin.create(DOMAIN, [ada], { createdAt: T0 })
    const keyring = await readKeysFor(domain.timeline, sealed, ada.sealingDid, ada.sealingKey)

    await eraseDomain({ keyring, resourceId: RESOURCE, admin: boss, now: T0 })
    expect(await keyring.keyFor(1)).toBeUndefined()

    // The relay hands the same sealed copies back.
    const reoffered = await readKeysFor(domain.timeline, sealed, ada.sealingDid, ada.sealingKey)
    keyring.refresh(domain.timeline, new Map([[1, (await reoffered.keyFor(1))!]]))

    expect(await keyring.keyFor(1)).toBeUndefined()
    expect(keyring.readableEpochs()).toEqual([])
  })

  /** And across a reload, if the destroyed set is persisted. */
  it("stays erased across a reload when the destroyed set is kept", async () => {
    const boss = await admin()
    const ada = await newMember("ada")
    const { admin: domain, sealed } = await KeyDomainAdmin.create(DOMAIN, [ada], { createdAt: T0 })
    const keyring = await readKeysFor(domain.timeline, sealed, ada.sealingDid, ada.sealingKey)

    const outcome = await eraseDomain({
      keyring,
      resourceId: RESOURCE,
      admin: boss,
      now: T0,
    })

    const reloaded = await readKeysFor(
      domain.timeline,
      sealed,
      ada.sealingDid,
      ada.sealingKey,
      outcome.destroyed,
    )
    expect(await reloaded.keyFor(1)).toBeUndefined()
  })

  it("lists the ciphertext worth asking the relay to drop", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    const outcome = await eraseDomain({
      keyring: keyring,
      resourceId: RESOURCE,
      admin: boss,
      envelopes: [anEnvelope(1, 1), anEnvelope(5, 2)],
      snapshots: [aSnapshot("a", 2)],
      now: T0,
    })

    expect(outcome.ciphertext.envelopes).toHaveLength(2)
    expect(outcome.ciphertext.snapshots).toEqual(["a"])
  })
})

/* ---- purging history ----------------------------------------------------- */

describe("eraseHistory", () => {
  /** The whole reason the interlock exists. */
  it("refuses a purge that would take the document with it", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    await expect(
      eraseHistory({
        keyring: keyring,
        resourceId: RESOURCE,
        admin: boss,
        throughEpoch: 3,
        snapshots: [],
        envelopes: [anEnvelope(1, 1)],
        now: T0,
      }),
    ).rejects.toThrow(ErasureRefused)

    // Nothing was destroyed by the refusal.
    expect(keyring.readableEpochs().length).toBeGreaterThan(0)
  })

  it("purges when a snapshot under a surviving epoch preserves the content", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    const outcome = await eraseHistory({
      keyring: keyring,
      resourceId: RESOURCE,
      admin: boss,
      throughEpoch: 3,
      snapshots: [aSnapshot("old", 2), aSnapshot("current", 5)],
      now: T0,
    })

    expect(outcome.record.preservedBy).toBe("current")
    expect(keyring.readableEpochs()).toEqual([4, 5])
    expect(await keyring.keyFor(2)).toBeUndefined()
    expect(await keyring.keyFor(5)).toBeDefined()
  })

  it("proceeds when the caller says plainly that the loss is intended", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    const outcome = await eraseHistory({
      keyring: keyring,
      resourceId: RESOURCE,
      admin: boss,
      throughEpoch: 3,
      snapshots: [],
      allowContentLoss: true,
      now: T0,
    })

    expect(outcome.impact.contentLost).toBe(true)
    expect(keyring.readableEpochs()).toEqual([4, 5])
  })

  /** Erasing the current epoch is not a purge, it is a deletion. */
  it("refuses to purge through the current epoch", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    await expect(
      eraseHistory({
        keyring: keyring,
        resourceId: RESOURCE,
        admin: boss,
        throughEpoch: 5,
        now: T0,
      }),
    ).rejects.toThrow(/notebook deletion/)
  })
})

/* ---- surgical note erasure ----------------------------------------------- */

describe("note erasure", () => {
  /**
   * There is no key that unlocks one note and nothing else until the note has
   * its own domain, so this has to refuse rather than erase the notebook.
   */
  it("refuses an unpromoted note and says what would work", () => {
    const check = noteErasability({ noteId: "note:kyoto", promoted: false })

    expect(check.erasable).toBe(false)
    expect(check.domain).toBeNull()
    expect(check.reason).toMatch(/every other note also uses/)
    expect(check.remedy).toMatch(/give the note its own key first/i)
  })

  /** Promotion is not retroactive, and pretending otherwise would be the lie. */
  it("reports the horizon on a promoted note", () => {
    const check = noteErasability({
      noteId: "note:kyoto",
      promoted: true,
      promotedAtEpoch: 4,
    })

    expect(check.erasable).toBe(true)
    expect(check.domain).toBe(notePromotionDomain("note:kyoto"))
    expect(check.horizon).toBe(4)
    expect(check.remedy).toMatch(/before notebook epoch 4/)
  })

  it("erases a promoted note's own domain, and nothing else", async () => {
    const boss = await admin()
    const ada = await newMember("ada")
    const noteDomain = notePromotionDomain("note:kyoto")
    const { admin: domain, sealed } = await KeyDomainAdmin.create(noteDomain, [ada], {
      createdAt: T0,
    })
    const keyring = await readKeysFor(domain.timeline, sealed, ada.sealingDid, ada.sealingKey)

    const outcome = await eraseNote({
      keyring,
      resourceId: "notebook:travel/note:kyoto",
      admin: boss,
      noteId: "note:kyoto",
      promoted: true,
      promotedAtEpoch: 4,
      now: T0,
    })

    expect(keyring.readableEpochs()).toEqual([])
    expect(outcome.horizon).toBe(4)
    expect(outcome.record.domain).toBe(noteDomain)
  })

  it("refuses a keyring for the wrong domain", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()

    await expect(
      eraseNote({
        keyring: keyring,
        resourceId: RESOURCE,
        admin: boss,
        noteId: "note:kyoto",
        promoted: true,
      }),
    ).rejects.toThrow(/not the note's own domain/)
  })
})

/* ---- honouring someone else's order -------------------------------------- */

describe("applyErasure", () => {
  it("destroys from this holder's anchors, not the issuer's", async () => {
    const boss = await admin()
    const { domain, keyring } = await aDomain()
    const record = await orderErasure({
      signingKey: boss.signingKey,
      issuer: boss.did,
      domain: domain.domain,
      resourceId: RESOURCE,
      scope: "history",
      throughEpoch: 3,
      preservedBy: "current",
      issuedAt: T0,
    })

    const destroyed = applyErasure(keyring, record)

    expect(destroyed).toEqual([1, 2, 3])
    expect(keyring.readableEpochs()).toEqual([4, 5])
  })

  it("ignores an order for another domain", async () => {
    const boss = await admin()
    const { keyring } = await aDomain()
    const record = await orderErasure({
      signingKey: boss.signingKey,
      issuer: boss.did,
      domain: "notebook:someone-else",
      resourceId: "notebook:someone-else",
      scope: "domain",
      throughEpoch: 9,
      issuedAt: T0,
    })

    expect(applyErasure(keyring, record)).toEqual([])
    expect(keyring.readableEpochs().length).toBeGreaterThan(0)
  })
})
