import { expect, test } from "@playwright/test"

import {
  addImage,
  admit,
  aPng,
  askToJoin,
  comeBack,
  createNotebook,
  editor,
  enter,
  imagesShown,
  invite,
  person,
  remove,
  type,
} from "./people"

test("two people join a notebook and write in the same note", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  const ada = await person(browser, "Ada")

  await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  const deviceCode = await askToJoin(ada, link, code)
  await admit(sindre, deviceCode)
  await enter(ada)

  await type(sindre, " Written by Sindre.")
  await expect(editor(ada.page)).toContainText("Written by Sindre.")

  await type(ada, " And by Ada.")
  await expect(editor(sindre.page)).toContainText("And by Ada.")
})

/**
 * The invitation, the request and the grant each wait at the relay, so the two
 * of them are never online together - and what was written before Ada was
 * invited still reaches her.
 */
test("someone joins while the owner is away, and is let in while they are away", async ({ browser }) => {
  let sindre = await person(browser, "Sindre")
  let ada = await person(browser, "Ada")

  const notebookId = await createNotebook(sindre, "Travel")
  await type(sindre, " Written before Ada was invited.")
  const { link, code } = await invite(sindre, "Ada")
  await sindre.page.close()

  const deviceCode = await askToJoin(ada, link, code)
  await ada.page.close()

  sindre = await comeBack(sindre)
  await sindre.page.goto(`/nb/${notebookId}`)
  await admit(sindre, deviceCode)
  await sindre.page.close()

  ada = await comeBack(ada)
  await ada.page.goto(new URL(link).pathname)
  await enter(ada)
  await expect(editor(ada.page)).toContainText("Written before Ada was invited.")
})

/** Sequence numbers that restarted after a reload were silently dropped as duplicates. */
test("edits keep arriving after either of them reloads", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  const ada = await person(browser, "Ada")

  await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  await admit(sindre, await askToJoin(ada, link, code))
  await enter(ada)
  await type(sindre, " Before any reload.")
  await expect(editor(ada.page)).toContainText("Before any reload.")

  await ada.page.reload()
  await type(ada, " Ada, after reloading.")
  await expect(editor(sindre.page)).toContainText("Ada, after reloading.")

  await sindre.page.reload()
  await type(sindre, " Sindre, after reloading.")
  await expect(editor(ada.page)).toContainText("Sindre, after reloading.")
})

test("a removed member is told, and gets nothing written afterwards", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  const ada = await person(browser, "Ada")

  await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  await admit(sindre, await askToJoin(ada, link, code))
  await enter(ada)
  await type(sindre, " Before removal.")
  await expect(editor(ada.page)).toContainText("Before removal.")

  await remove(sindre, "Ada")

  await expect(ada.page.getByText("You no longer have access to this notebook")).toBeVisible()
  await expect(editor(ada.page)).toHaveAttribute("contenteditable", "false")

  await type(sindre, " After removal.")
  // Absence has no event to wait for; give it longer than a delivery takes.
  await ada.page.waitForTimeout(4_000)
  await expect(editor(ada.page)).not.toContainText("After removal.")
  await expect(editor(ada.page)).toContainText("Before removal.")
})

/** The old transfer needed whoever had the image to still be online. */
test("an image reaches a member after whoever added it has gone", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  let ada = await person(browser, "Ada")

  const notebookId = await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  await admit(sindre, await askToJoin(ada, link, code))
  await enter(ada)
  await ada.page.close()

  await addImage(sindre, "kyoto.png", aPng())
  await expect.poll(() => imagesShown(sindre.page)).toBe(1)
  await sindre.page.waitForTimeout(1_000)
  await sindre.page.close()

  ada = await comeBack(ada)
  await ada.page.goto(`/nb/${notebookId}`)
  await expect.poll(() => imagesShown(ada.page), { timeout: 30_000 }).toBe(1)
})
