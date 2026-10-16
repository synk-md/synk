import { describe, expect, it } from "vitest"

import { generateSealingKey, generateSigningKey } from "@/lib/crypto"
import { createDeviceRecord, didFromSigningKey, type DeviceIdentity } from "@/lib/identity"

import { createGenesis } from "./genesis"
import { generateRecoveryCode, recoveryIdentity, recoveryKeyOf } from "./recovery-code"
import { nameStandby, resolveLineage, signSuccession, type Standby, type Succession } from "./succession"

const WORKSPACE = "workspace:travel"

async function aDevice(): Promise<DeviceIdentity> {
  const signingKey = await generateSigningKey()
  const sealingKey = await generateSealingKey()
  const record = await createDeviceRecord(signingKey, sealingKey)
  return { did: didFromSigningKey(signingKey.publicKey), clientId: record.clientId, signingKey, sealingKey, record }
}

/** Maren's laptop founded the notebook, with a recovery code; her phone is named as able to take over. */
async function aNotebook() {
  const laptop = await aDevice()
  const phone = await aDevice()
  const code = generateRecoveryCode("travel")
  const genesis = await createGenesis({
    signingKey: laptop.signingKey,
    owner: laptop.did,
    workspace: WORKSPACE,
    resource: "notebook:travel",
    recovery: await recoveryKeyOf(code.secret),
  })
  const standbys: Standby[] = [await nameStandby({ signingKey: laptop.signingKey, owner: laptop.did, workspace: WORKSPACE, device: phone.did })]
  const successions: Succession[] = []
  const takeOver = async (by: DeviceIdentity, from = laptop.did) => {
    successions.push(await signSuccession({ signingKey: by.signingKey, workspace: WORKSPACE, from, to: by.did, by: "standby", signer: by.did }))
  }
  const recover = async (to: string, from: string, secret = code.secret) => {
    const key = await recoveryIdentity(secret)
    const next = generateRecoveryCode("travel")
    successions.push(
      await signSuccession({
        signingKey: key.signingKey,
        workspace: WORKSPACE,
        from,
        to,
        by: "recovery",
        signer: key.did,
        nextRecovery: await recoveryKeyOf(next.secret),
      }),
    )
    return next
  }
  const lineage = () => resolveLineage(genesis, standbys, successions)
  return { laptop, phone, code, genesis, standbys, successions, takeOver, recover, lineage }
}

describe("who owns a notebook now", () => {
  it("is the genesis owner until someone takes over", async () => {
    const notebook = await aNotebook()
    expect(await notebook.lineage()).toMatchObject({ status: "established", owner: notebook.laptop.did })
  })

  it("passes to a device the owner named, when it takes over", async () => {
    const notebook = await aNotebook()
    await notebook.takeOver(notebook.phone)
    expect(await notebook.lineage()).toMatchObject({ owner: notebook.phone.did, owners: [notebook.laptop.did, notebook.phone.did] })
  })

  it("does not pass to a device nobody named", async () => {
    const notebook = await aNotebook()
    await notebook.takeOver(await aDevice())
    expect((await notebook.lineage()).owner).toBe(notebook.laptop.did)
  })

  /** A thief with the laptop can name a device of their own. Then nobody's word settles it but the code's. */
  it("is disputed when two named devices take over", async () => {
    const notebook = await aNotebook()
    const thief = await aDevice()
    notebook.standbys.push(await nameStandby({ signingKey: notebook.laptop.signingKey, owner: notebook.laptop.did, workspace: WORKSPACE, device: thief.did }))
    await notebook.takeOver(thief)
    await notebook.takeOver(notebook.phone)
    expect(await notebook.lineage()).toMatchObject({ status: "disputed", owner: null })
  })

  it("is settled by the recovery code, over any named device", async () => {
    const notebook = await aNotebook()
    const thief = await aDevice()
    notebook.standbys.push(await nameStandby({ signingKey: notebook.laptop.signingKey, owner: notebook.laptop.did, workspace: WORKSPACE, device: thief.did }))
    await notebook.takeOver(thief)
    const fresh = await aDevice()
    await notebook.recover(fresh.did, notebook.laptop.did)

    expect(await notebook.lineage()).toMatchObject({ status: "established", owner: fresh.did })
  })

  /** The code changes with each recovery, so a code once used cannot be used again. */
  it("takes the next code after a recovery, and not the old one", async () => {
    const notebook = await aNotebook()
    const first = await aDevice()
    const next = await notebook.recover(first.did, notebook.laptop.did)
    const second = await aDevice()
    await notebook.recover(second.did, first.did)
    expect((await notebook.lineage()).owner).toBe(first.did)

    const third = await aDevice()
    await notebook.recover(third.did, first.did, next.secret)
    expect((await notebook.lineage()).owner).toBe(third.did)
  })

  /** Once ownership has passed on, what the old owner's key signs is about someone who is no longer owner. */
  it("ignores hand-overs from an owner who has already been succeeded", async () => {
    const notebook = await aNotebook()
    await notebook.takeOver(notebook.phone)
    const thief = await aDevice()
    notebook.standbys.push(await nameStandby({ signingKey: notebook.laptop.signingKey, owner: notebook.laptop.did, workspace: WORKSPACE, device: thief.did }))
    await notebook.takeOver(thief)

    // Two hand-overs from the laptop now: disputed, and settled by the code in favour of the phone.
    expect((await notebook.lineage()).status).toBe("disputed")
    await notebook.recover(notebook.phone.did, notebook.laptop.did)
    expect(await notebook.lineage()).toMatchObject({ status: "established", owner: notebook.phone.did })
  })

  it("cannot be recovered without a code in the genesis", async () => {
    const laptop = await aDevice()
    const genesis = await createGenesis({ signingKey: laptop.signingKey, owner: laptop.did, workspace: WORKSPACE, resource: "notebook:travel" })
    const key = await recoveryIdentity(generateRecoveryCode("travel").secret)
    const fresh = await aDevice()
    const succession = await signSuccession({
      signingKey: key.signingKey,
      workspace: WORKSPACE,
      from: laptop.did,
      to: fresh.did,
      by: "recovery",
      signer: key.did,
      nextRecovery: await recoveryKeyOf(generateRecoveryCode("travel").secret),
    })
    expect((await resolveLineage(genesis, [], [succession])).owner).toBe(laptop.did)
  })
})

describe("recovery codes", () => {
  it("read back what was written, whatever the case and spacing", async () => {
    const { parseRecoveryCode } = await import("./recovery-code")
    const code = generateRecoveryCode("abcDEF123")
    const sloppy = `  ${code.notebookId}.${code.text.split(".")[1].toLowerCase().replace(/-/g, " ")} `
    expect(parseRecoveryCode(sloppy).secret).toEqual(code.secret)
    expect(parseRecoveryCode(sloppy).notebookId).toBe("abcDEF123")
  })
})
