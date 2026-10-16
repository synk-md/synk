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
  envelopesPublished,
  imagesShown,
  invite,
  person,
  remove,
  type,
} from "./people"

test("two people join a notebook and write in the same note", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  const deviceCode = await askToJoin(ada, link, code)
  await admit(maren, deviceCode)
  await enter(ada)

  await type(maren, " Written by Maren.")
  await expect(editor(ada.page)).toContainText("Written by Maren.")

  await type(ada, " And by Ada.")
  await expect(editor(maren.page)).toContainText("And by Ada.")
})

/** A transaction per keystroke used to be an envelope per keystroke, kept forever. */
test("typing a sentence costs the relay a few envelopes, not one per key", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")
  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await type(maren, " Warm up.")
  await expect(editor(ada.page)).toContainText("Warm up.")
  await maren.page.waitForTimeout(1_000)

  const before = await envelopesPublished()
  const sentence = " Thirty-two characters of typing."
  await type(maren, sentence)
  await expect(editor(ada.page)).toContainText(sentence.trim())
  const spent = (await envelopesPublished()) - before

  console.log(`${String(sentence.length)} characters cost ${String(spent)} envelopes`)
  expect(spent).toBeLessThan(sentence.length / 4)
})

/**
 * The invitation, the request and the grant each wait at the relay, so the two
 * of them are never online together - and what was written before Ada was
 * invited still reaches her.
 */
test("someone joins while the owner is away, and is let in while they are away", async ({ browser }) => {
  let maren = await person(browser, "Maren")
  let ada = await person(browser, "Ada")

  const notebookId = await createNotebook(maren, "Travel")
  await type(maren, " Written before Ada was invited.")
  const { link, code } = await invite(maren, "Ada")
  await maren.page.close()

  const deviceCode = await askToJoin(ada, link, code)
  await ada.page.close()

  maren = await comeBack(maren)
  await maren.page.goto(`/nb/${notebookId}`)
  await admit(maren, deviceCode)
  await maren.page.close()

  ada = await comeBack(ada)
  await ada.page.goto(new URL(link).pathname)
  await enter(ada)
  await expect(editor(ada.page)).toContainText("Written before Ada was invited.")
})

/** Sequence numbers that restarted after a reload were silently dropped as duplicates. */
test("edits keep arriving after either of them reloads", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await type(maren, " Before any reload.")
  await expect(editor(ada.page)).toContainText("Before any reload.")

  await ada.page.reload()
  await type(ada, " Ada, after reloading.")
  await expect(editor(maren.page)).toContainText("Ada, after reloading.")

  await maren.page.reload()
  await type(maren, " Maren, after reloading.")
  await expect(editor(ada.page)).toContainText("Maren, after reloading.")
})

test("a removed member is told, and gets nothing written afterwards", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const ada = await person(browser, "Ada")

  await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await type(maren, " Before removal.")
  await expect(editor(ada.page)).toContainText("Before removal.")

  await remove(maren, "Ada")

  await expect(ada.page.getByText("You no longer have access to this notebook")).toBeVisible()
  await expect(editor(ada.page)).toHaveAttribute("contenteditable", "false")

  await type(maren, " After removal.")
  // Absence has no event to wait for; give it longer than a delivery takes.
  await ada.page.waitForTimeout(4_000)
  await expect(editor(ada.page)).not.toContainText("After removal.")
  await expect(editor(ada.page)).toContainText("Before removal.")
})

/** The old transfer needed whoever had the image to still be online. */
test("an image reaches a member after whoever added it has gone", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  let ada = await person(browser, "Ada")

  const notebookId = await createNotebook(maren, "Travel")
  const { link, code } = await invite(maren, "Ada")
  await admit(maren, await askToJoin(ada, link, code))
  await enter(ada)
  await ada.page.close()

  await addImage(maren, "kyoto.png", aPng())
  await expect.poll(() => imagesShown(maren.page)).toBe(1)
  await maren.page.waitForTimeout(1_000)
  await maren.page.close()

  ada = await comeBack(ada)
  await ada.page.goto(`/nb/${notebookId}`)
  await expect.poll(() => imagesShown(ada.page), { timeout: 30_000 }).toBe(1)
})
