import { expect, test, type Page } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, linkDevice, memberCount, person, type, type Person } from "./people"

/** The notebooks this browser has, by id. */
function notebookIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("notebooks:v1") ?? "{}") as { notebooks?: { id: string }[] }
    return (state.notebooks ?? []).map((notebook) => notebook.id)
  })
}

/** A second notebook, from the notebook menu, as someone already using the app makes one. */
async function anotherNotebook(owner: Person, title: string): Promise<string> {
  const { page } = owner
  const before = new URL(page.url()).pathname
  await page.getByRole("button", { name: "Notebook options" }).click()
  await page.getByRole("button", { name: "Manage notebooks" }).click()
  await page.getByRole("button", { name: "New notebook" }).click()
  await page.locator("#new-notebook-name").fill(title)
  await page.getByRole("button", { name: "Create notebook" }).click()
  const recovery = page.getByRole("dialog", { name: "Save this notebook's recovery code" })
  await recovery.getByLabel("I have saved it somewhere safe").check()
  await recovery.getByRole("button", { name: "Done" }).click()
  await expect(page).not.toHaveURL(before)
  await expect(editor(page)).toBeVisible()
  return new URL(page.url()).pathname.split("/")[2]
}

/**
 * Linking a phone used to be a copy of the notebooks the laptop had then.
 * Now the phone follows: what the laptop creates or joins afterwards reaches
 * it too, as the same person.
 */
test("a linked phone gets the notebooks its person creates and joins afterwards", async ({ browser }) => {
  const laptop = await person(browser, "Maren")
  const phone = await person(browser, "Maren's phone")
  await createNotebook(laptop, "Travel")
  await linkDevice(laptop, phone)

  const work = await anotherNotebook(laptop, "Work")
  await type(laptop, " Planned on the laptop, after the phone was linked.")
  await expect.poll(() => notebookIds(phone.page), { timeout: 60_000 }).toContain(work)
  await phone.page.goto(`/nb/${work}`)
  await expect(editor(phone.page)).toContainText("Planned on the laptop, after the phone was linked.", { timeout: 30_000 })

  // Joining someone else's notebook brings the phone along as Maren, not as another member.
  const ada = await person(browser, "Ada")
  const club = await createNotebook(ada, "Book club")
  await type(ada, " The reading list from Ada.")
  const { link, code } = await invite(ada, "Maren")
  await admit(ada, await askToJoin(laptop, link, code))
  await enter(laptop)

  await expect.poll(() => notebookIds(phone.page), { timeout: 60_000 }).toContain(club)
  await phone.page.goto(`/nb/${club}`)
  await expect(editor(phone.page)).toContainText("The reading list from Ada.", { timeout: 30_000 })
  await type(phone, " Added from the phone of Maren.")
  await expect(editor(ada.page)).toContainText("Added from the phone of Maren.")
  expect(await memberCount(ada.page)).toBe("2 members")
})
