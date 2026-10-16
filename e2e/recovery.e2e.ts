import { expect, test, type Page } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, linkDevice, openShare, person, type } from "./people"

async function yourDevices(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).first().click()
  await page.getByRole("button", { name: "Manage devices" }).click()
  return page.getByRole("dialog", { name: "Your devices" })
}

/**
 * Maren's laptop owns the notebook and names her phone as able to take over.
 * The laptop is lost: the phone takes over, and Ada, whom the laptop let in,
 * is still in and still heard.
 */
test("a phone the owner named takes over when the laptop is lost", async ({ browser }) => {
  const laptop = await person(browser, "Maren")
  const phone = await person(browser, "Maren's phone")
  const ada = await person(browser, "Ada")

  await createNotebook(laptop, "Travel")
  await type(laptop, " Planned on the laptop.")
  await linkDevice(laptop, phone)
  const { link, code } = await invite(laptop, "Ada")
  await admit(laptop, await askToJoin(ada, link, code))
  await enter(ada)

  const devices = await yourDevices(laptop.page)
  await devices.getByRole("button", { name: "Let it take over" }).click()
  await expect(devices.getByText("Can take over")).toBeVisible({ timeout: 30_000 })
  await laptop.page.close()

  const onPhone = await yourDevices(phone.page)
  await onPhone.getByRole("button", { name: "Take over as owner" }).click()
  await onPhone.getByRole("button", { name: /The owner's device is lost/ }).click()
  await expect(onPhone.getByText(/You own 1 notebook now/)).toBeVisible({ timeout: 60_000 })
  await onPhone.getByRole("button", { name: "Close" }).first().click()

  const share = await openShare(phone.page)
  await expect(share.getByRole("button", { name: /Invite someone/ })).toBeVisible({ timeout: 30_000 })
  await expect(share.getByText("2 members")).toBeVisible()
  await share.getByRole("button", { name: "Close" }).first().click()

  await type(ada, " Ada, after the laptop was lost.")
  await expect(editor(phone.page)).toContainText("Ada, after the laptop was lost.")
})

/**
 * Every device lost: on a new one, the recovery code saved when the notebook
 * was made gives it back, written notes and all, with a new code to save.
 */
test("a new device recovers the notebook with its code", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const recoveryCode = maren.recoveryCode!
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await type(maren, " Written before everything was lost.")
  await expect(editor(ada.page)).toContainText("Written before everything was lost.")
  await maren.page.close()

  const fresh = await person(browser, "Maren, on a new laptop")
  await fresh.page.goto("/recover")
  await fresh.page.getByLabel("Recovery code").fill(recoveryCode)
  await fresh.page.getByRole("button", { name: "Recover" }).click()
  const next = fresh.page.getByRole("dialog", { name: "Save the new recovery code" })
  await expect(next).toBeVisible({ timeout: 60_000 })
  expect((await next.getByLabel("Recovery code").inputValue()).trim()).not.toBe(recoveryCode)
  await next.getByLabel("I have saved it somewhere safe").check()
  await next.getByRole("button", { name: "Done" }).click()

  await fresh.page.getByRole("link", { name: "Open the notebook" }).click()
  await expect(editor(fresh.page)).toContainText("Written before everything was lost.", { timeout: 60_000 })
})
