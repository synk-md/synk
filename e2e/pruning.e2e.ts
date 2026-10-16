import { expect, test } from "@playwright/test"

import {
  admit,
  askToJoin,
  createNotebook,
  editor,
  enter,
  envelopesPruned,
  invite,
  linkDevice,
  person,
  type,
} from "./people"

// Only meaningful with a relay that lets go at once rather than after a month:
// RELAY_PRUNE_AFTER_MS=0 pnpm test:e2e
const PRUNING_AT_ONCE = process.env.RELAY_PRUNE_AFTER_MS === "0"

/**
 * Once the relay has let the start of a note go behind the owner's anchor, a
 * device that never had it - a phone linked afterwards - still gets all of it.
 */
test("a device linked after the relay let go of a note's start still gets all of it", async ({ browser }) => {
  test.skip(!PRUNING_AT_ONCE, "needs a relay that prunes at once")
  const laptop = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(laptop, "Travel")
  const { link, code } = await invite(laptop, "Ada")
  await admit(laptop, await askToJoin(ada, link, code))
  await enter(ada)

  await type(ada, " Ada wrote this first.")
  await expect(editor(laptop.page)).toContainText("Ada wrote this first.")

  const before = await envelopesPruned()
  // A checkpoint the owner names is an anchor like any other.
  await laptop.page.getByRole("button", { name: "History of this note" }).click()
  const history = laptop.page.getByRole("dialog", { name: "History of this note" })
  await history.getByRole("button", { name: /Name this point/ }).click()
  await laptop.page.getByLabel("What to call it").fill("Anchor")
  await laptop.page.getByRole("button", { name: "Save checkpoint" }).click()
  await expect(history.getByText("Anchor")).toBeVisible()
  await history.getByRole("button", { name: "Close" }).first().click()
  await expect.poll(envelopesPruned, { timeout: 30_000 }).toBeGreaterThan(before)

  await type(laptop, " Then Maren.")
  await expect(editor(ada.page)).toContainText("Then Maren.")

  const phone = await person(browser, "Maren's phone")
  await linkDevice(laptop, phone)
  await expect(editor(phone.page)).toContainText("Ada wrote this first.")
  await expect(editor(phone.page)).toContainText("Then Maren.")

  await type(phone, " And the phone.")
  await expect(editor(ada.page)).toContainText("And the phone.")
})
