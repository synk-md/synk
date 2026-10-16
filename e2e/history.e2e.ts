import { expect, test } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, person, type } from "./people"

/**
 * A named point, more writing, and going back to it - which is a new edit,
 * synced like any other, so the other person's copy goes back too.
 */
test("a note goes back to a named checkpoint, for everyone working on it", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)

  await type(maren, " The first draft.")
  await expect(editor(ada.page)).toContainText("The first draft.")

  await maren.page.getByRole("button", { name: "History of this note" }).click()
  const history = maren.page.getByRole("dialog", { name: "History of this note" })
  await history.getByRole("button", { name: /Name this point/ }).click()
  await maren.page.getByLabel("What to call it").fill("Before the rewrite")
  await maren.page.getByRole("button", { name: "Save checkpoint" }).click()
  await expect(history.getByText("Before the rewrite")).toBeVisible()
  await history.getByRole("button", { name: "Close" }).first().click()

  await type(maren, " A rewrite nobody wanted.")
  await expect(editor(ada.page)).toContainText("A rewrite nobody wanted.")

  await maren.page.getByRole("button", { name: "History of this note" }).click()
  await history.getByText("Before the rewrite").click()
  const restore = maren.page.getByRole("dialog", { name: /Go back to/ })
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(restore).toBeHidden()

  await expect(editor(maren.page)).not.toContainText("A rewrite nobody wanted.")
  await expect(editor(maren.page)).toContainText("The first draft.")
  await expect(editor(ada.page)).not.toContainText("A rewrite nobody wanted.")
  await expect(editor(ada.page)).toContainText("The first draft.")
})

/**
 * A shared note's history is who wrote what, in turn. Going back to the end of
 * Ada's writing keeps hers and Maren's before it, and drops what came after.
 */
test("a shared note goes back to the end of someone's edits", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)

  await type(maren, " The opening by Maren.")
  await expect(editor(ada.page)).toContainText("The opening by Maren.")
  await type(ada, " The middle by Ada.")
  await expect(editor(maren.page)).toContainText("The middle by Ada.")
  await type(maren, " A closing nobody wanted.")
  await expect(editor(ada.page)).toContainText("A closing nobody wanted.")

  await maren.page.getByRole("button", { name: "History of this note" }).click()
  const history = maren.page.getByRole("dialog", { name: "History of this note" })
  const adas = history.getByRole("button").filter({ hasText: "Edits" }).filter({ hasText: "Ada" })
  await expect(adas).toHaveCount(1)
  await adas.click()
  const restore = maren.page.getByRole("dialog", { name: "Go back to the end of Ada's edits?" })
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(restore).toBeHidden()

  for (const page of [maren.page, ada.page]) {
    await expect(editor(page)).not.toContainText("A closing nobody wanted.")
    await expect(editor(page)).toContainText("The opening by Maren.")
    await expect(editor(page)).toContainText("The middle by Ada.")
  }
})
