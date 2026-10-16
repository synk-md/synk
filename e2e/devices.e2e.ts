import { expect, test } from "@playwright/test"

import {
  admit,
  askToJoin,
  createNotebook,
  editor,
  enter,
  invite,
  linkDevice,
  memberCount,
  person,
  type,
  unlinkDevice,
} from "./people"

/**
 * One person, two devices: the second sees what the first wrote before it was
 * linked, writes as them, and counts as one member, not two.
 */
test("a person links their phone, and it is them, not a second member", async ({ browser }) => {
  const laptop = await person(browser, "Maren")
  const phone = await person(browser, "Maren's phone")

  await createNotebook(laptop, "Travel")
  await type(laptop, " Written on the laptop before the phone existed.")

  await linkDevice(laptop, phone)
  await expect(editor(phone.page)).toContainText("Written on the laptop before the phone existed.")

  await type(phone, " And from the phone.")
  await expect(editor(laptop.page)).toContainText("And from the phone.")

  // A second person, so "one member" is not just a notebook nobody shares.
  const ada = await person(browser, "Ada")
  const { link, code } = await invite(laptop, "Ada")
  await admit(laptop, await askToJoin(ada, link, code))
  await enter(ada)
  await type(phone, " Ada should see what the phone wrote.")
  await expect(editor(ada.page)).toContainText("Ada should see what the phone wrote.")

  expect(await memberCount(laptop.page)).toBe("2 members")
})

/** The owner cannot be removed, so before unlinking an owner's lost phone could never be cut off. */
test("the owner takes a lost phone out, and it gets nothing written afterwards", async ({ browser }) => {
  const laptop = await person(browser, "Maren")
  const phone = await person(browser, "Maren's phone")

  await createNotebook(laptop, "Travel")
  await type(laptop, " Before the phone was lost.")
  await linkDevice(laptop, phone)
  await expect(editor(phone.page)).toContainText("Before the phone was lost.")

  await unlinkDevice(laptop)

  await expect(phone.page.getByText("You no longer have access to this notebook")).toBeVisible({ timeout: 30_000 })
  await expect(editor(phone.page)).toHaveAttribute("contenteditable", "false")

  await type(laptop, " After it was taken out.")
  // Absence has no event to wait for; give it longer than a delivery takes.
  await phone.page.waitForTimeout(4_000)
  await expect(editor(phone.page)).not.toContainText("After it was taken out.")
  await expect(editor(phone.page)).toContainText("Before the phone was lost.")
})

/**
 * The owner's phone is the owner: away from the laptop it lets someone in. And
 * when the phone is later lost and unlinked, the person it let in stays in.
 */
test("the owner's phone lets someone in, and they stay in once the phone is unlinked", async ({ browser }) => {
  const laptop = await person(browser, "Maren")
  const phone = await person(browser, "Maren's phone")
  const ada = await person(browser, "Ada")

  await createNotebook(laptop, "Travel")
  await type(laptop, " Planned on the laptop.")
  await linkDevice(laptop, phone)
  await expect(editor(phone.page)).toContainText("Planned on the laptop.")

  const { link, code } = await invite(phone, "Ada")
  await admit(phone, await askToJoin(ada, link, code))
  await enter(ada)
  await expect(editor(ada.page)).toContainText("Planned on the laptop.")

  await unlinkDevice(laptop)
  await expect(phone.page.getByText("You no longer have access to this notebook")).toBeVisible({ timeout: 30_000 })

  await type(ada, " Ada, after the phone was gone.")
  await expect(editor(laptop.page)).toContainText("Ada, after the phone was gone.")
  expect(await memberCount(laptop.page)).toBe("2 members")
})
