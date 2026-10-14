import { expect, test } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, linkDevice, memberCount, person, type } from "./people"

/**
 * One person, two devices: the second sees what the first wrote before it was
 * linked, writes as them, and counts as one member, not two.
 */
test("a person links their phone, and it is them, not a second member", async ({ browser }) => {
  const laptop = await person(browser, "Sindre")
  const phone = await person(browser, "Sindre's phone")

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
