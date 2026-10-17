import { expect, test, type Page } from "@playwright/test"

import { aPng, createNotebook, editor, person } from "./people"

/** The images this browser stores, by id. */
function storedImages(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("synk-image-assets")
        request.onerror = () => reject(new Error(request.error?.message ?? "could not open"))
        request.onsuccess = () => {
          const keys = request.result.transaction("assets").objectStore("assets").getAllKeys()
          keys.onsuccess = () => resolve((keys.result as string[]).sort())
          keys.onerror = () => reject(new Error(keys.error?.message ?? "could not read"))
        }
      }),
  )
}

const row = (page: Page, name: string) => page.locator(".tree-row").filter({ hasText: new RegExp(`^${name}$`) })

async function fromMenu(page: Page, name: string, item: string) {
  await row(page, name).click({ button: "right" })
  await page.getByText(item, { exact: true }).click()
}

async function placeImage(page: Page, name: string, png: Buffer, expected: number) {
  await editor(page).click()
  await page.keyboard.press("End")
  await page
    .locator('input[type="file"][accept*="image"]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name, mimeType: "image/png", buffer: png })
  await expect(editor(page).locator("img")).toHaveCount(expected)
}

test("an image goes with the last note that showed it, and not before", async ({ browser }) => {
  const maren = await person(browser, "Maren")
  const { page } = maren
  await createNotebook(maren, "Travel")

  await placeImage(page, "ocean.png", aPng(48, 32, [20, 90, 200]), 1)
  // The copy shows the same image: one stored image, two notes using it.
  await fromMenu(page, "Welcome", "Make a copy")
  // A copy opens for renaming; the suggested name will do.
  await page.keyboard.press("Enter")
  await expect(row(page, "Welcome copy")).toBeVisible()
  await row(page, "Welcome").click()
  await expect(editor(page).locator("img")).toHaveCount(1)
  await placeImage(page, "forest.png", aPng(48, 32, [30, 160, 60]), 2)

  await expect.poll(() => storedImages(page)).toHaveLength(2)
  await row(page, "Assets").click()
  await expect(row(page, "ocean")).toBeVisible()
  await expect(row(page, "forest")).toBeVisible()
  const [first, second] = await storedImages(page)

  await fromMenu(page, "Welcome", "Delete")
  await expect(row(page, "Welcome")).toHaveCount(0)

  // The forest went with the only note that showed it; the copy still shows the ocean.
  await expect.poll(() => storedImages(page)).toHaveLength(1)
  await expect(row(page, "forest")).toHaveCount(0)
  await expect(row(page, "ocean")).toBeVisible()
  const [kept] = await storedImages(page)
  expect([first, second]).toContain(kept)

  await fromMenu(page, "Welcome copy", "Delete")
  await expect.poll(() => storedImages(page)).toEqual([])
  await expect(row(page, "ocean")).toHaveCount(0)
})
