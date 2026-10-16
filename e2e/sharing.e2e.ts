import { expect, test } from "@playwright/test"

import { admit, askToJoin, createNotebook, editor, enter, invite, openShare, person, type } from "./people"

/**
 * What the owner sets is what the other person's editor allows: read-only for
 * the notebook, and then editing for one note.
 */
test("the owner makes someone read-only, then lets them edit one note", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await type(ada, " Ada, while she could edit.")
  await expect(editor(maren.page)).toContainText("Ada, while she could edit.")

  const access = await openShare(maren.page)
  await access.getByRole("tab", { name: "Whole notebook" }).click()
  await access.getByRole("button", { name: "Change level for Ada" }).click()
  await access.getByLabel(/Can read/).check()
  await access.getByRole("button", { name: "Save level" }).click()

  await expect(ada.page.getByText("You can read this note, not edit it")).toBeVisible({ timeout: 30_000 })
  await expect(editor(ada.page)).toHaveAttribute("contenteditable", "false")

  await access.getByRole("tab", { name: "This note" }).click()
  await access.getByRole("button", { name: "Give access to this note" }).click()
  const share = maren.page.getByRole("dialog", { name: "Give access to this note" })
  await share.getByRole("option", { name: /Ada/ }).click()
  await share.getByRole("button", { name: "Give edit on this note" }).click()
  await expect(share).toBeHidden()

  await expect(ada.page.getByText("You can read this note, not edit it")).toBeHidden({ timeout: 30_000 })
  await type(ada, " Ada, editing this note again.")
  await expect(editor(maren.page)).toContainText("Ada, editing this note again.")
})

/** The dialog keeps one size; only what is inside it scrolls. */
test("the share dialog stays the same size whatever it shows", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  await createNotebook(maren, "Travel")

  const dialog = await openShare(maren.page)
  await expect(dialog.getByText("1 member")).toBeVisible()
  const size = async () => {
    const box = await dialog.boundingBox()
    return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) }
  }
  const onNote = await size()
  if (process.env.SHARE_SHOTS) await maren.page.screenshot({ path: `${process.env.SHARE_SHOTS}/note.png` })

  await dialog.getByRole("tab", { name: "Whole notebook" }).click()
  expect(await size()).toEqual(onNote)

  await dialog.getByRole("tab", { name: "This note" }).click()
  await dialog.getByLabel("Anyone with the link can read").check()
  await expect(dialog.getByLabel("Link to copy")).toBeVisible()
  expect(await size()).toEqual(onNote)
  if (process.env.SHARE_SHOTS) await maren.page.screenshot({ path: `${process.env.SHARE_SHOTS}/link.png` })
})
