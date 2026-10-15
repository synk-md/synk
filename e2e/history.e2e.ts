import { expect, test } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, person, type } from "./people"

/**
 * A named point, more writing, and going back to it - which is a new edit,
 * synced like any other, so the other person's copy goes back too.
 */
test("a note goes back to a named checkpoint, for everyone working on it", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  const ada = await person(browser, "Ada")

  await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  await admit(sindre, await askToJoin(ada, link, code))
  await enter(ada)

  await type(sindre, " The first draft.")
  await expect(editor(ada.page)).toContainText("The first draft.")

  await sindre.page.getByRole("button", { name: "History of this note" }).click()
  const history = sindre.page.getByRole("dialog", { name: "History of this note" })
  await history.getByRole("button", { name: /Name this point/ }).click()
  await sindre.page.getByLabel("What to call it").fill("Before the rewrite")
  await sindre.page.getByRole("button", { name: "Save checkpoint" }).click()
  await expect(history.getByText("Before the rewrite")).toBeVisible()
  await history.getByRole("button", { name: "Close" }).first().click()

  await type(sindre, " A rewrite nobody wanted.")
  await expect(editor(ada.page)).toContainText("A rewrite nobody wanted.")

  await sindre.page.getByRole("button", { name: "History of this note" }).click()
  await history.getByText("Before the rewrite").click()
  const restore = sindre.page.getByRole("dialog", { name: /Go back to/ })
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(restore).toBeHidden()

  await expect(editor(sindre.page)).not.toContainText("A rewrite nobody wanted.")
  await expect(editor(sindre.page)).toContainText("The first draft.")
  await expect(editor(ada.page)).not.toContainText("A rewrite nobody wanted.")
  await expect(editor(ada.page)).toContainText("The first draft.")
})

/**
 * A shared note's history is who wrote what, in turn. Going back to the end of
 * Ada's writing keeps hers and Sindre's before it, and drops what came after.
 */
test("a shared note goes back to the end of someone's edits", async ({ browser }) => {
  const sindre = await person(browser, "Sindre")
  const ada = await person(browser, "Ada")

  await createNotebook(sindre, "Travel")
  const { link, code } = await invite(sindre, "Ada")
  await admit(sindre, await askToJoin(ada, link, code))
  await enter(ada)

  await type(sindre, " The opening by Sindre.")
  await expect(editor(ada.page)).toContainText("The opening by Sindre.")
  await type(ada, " The middle by Ada.")
  await expect(editor(sindre.page)).toContainText("The middle by Ada.")
  await type(sindre, " A closing nobody wanted.")
  await expect(editor(ada.page)).toContainText("A closing nobody wanted.")

  await sindre.page.getByRole("button", { name: "History of this note" }).click()
  const history = sindre.page.getByRole("dialog", { name: "History of this note" })
  const adas = history.getByRole("button").filter({ hasText: "Edits" }).filter({ hasText: "Ada" })
  await expect(adas).toHaveCount(1)
  await adas.click()
  const restore = sindre.page.getByRole("dialog", { name: "Go back to the end of Ada's edits?" })
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(restore).toBeHidden()

  for (const page of [sindre.page, ada.page]) {
    await expect(editor(page)).not.toContainText("A closing nobody wanted.")
    await expect(editor(page)).toContainText("The opening by Sindre.")
    await expect(editor(page)).toContainText("The middle by Ada.")
  }
})
