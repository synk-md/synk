import { expect, test } from "@playwright/test"

import { createNotebook, editor, openShare, person, type } from "./people"

/**
 * A link is the other way in: no invitation, no keys of one's own. Read-only
 * means read-only to whoever opens it; switched to editing, what they type
 * reaches the owner.
 */
test("someone with the link reads the note, and once it is editable, writes in it", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const visitor = await person(browser, "Visitor")

  await createNotebook(maren, "Travel")
  await type(maren, " Shared by link.")

  const share = await openShare(maren.page)
  await share.getByLabel("Anyone with the link can read").check()
  const url = await share.getByLabel("Link to copy").inputValue()
  await expect(share.getByText(/readable by whoever holds it/)).toBeVisible()
  await share.getByRole("button", { name: "Close" }).first().click()

  await visitor.page.goto(new URL(url).pathname)
  await expect(editor(visitor.page)).toContainText("Shared by link.", { timeout: 30_000 })
  await expect(editor(visitor.page)).toHaveAttribute("contenteditable", "false")

  const again = await openShare(maren.page)
  await again.getByLabel("Anyone with the link can edit").check()
  await again.getByRole("button", { name: "Close" }).first().click()

  await expect(editor(visitor.page)).toHaveAttribute("contenteditable", "true", { timeout: 30_000 })
  await type(visitor, " Written by the visitor.")
  await expect(editor(maren.page)).toContainText("Written by the visitor.", { timeout: 30_000 })
})
