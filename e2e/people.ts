/**
 * Driving the app as the people using it: by what is on screen, never by
 * reaching into its state. A test that has to know how something works
 * underneath stops catching it when that changes.
 */

import { crc32, deflateSync } from "node:zlib"

import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"

export interface Person {
  name: string
  context: BrowserContext
  page: Page
}

/** A separate browser profile: their own device keys, storage and notebooks. */
export async function person(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on("pageerror", (error) => {
    console.log(`[${name}] page error: ${error.message}`)
  })
  return { name, context, page }
}

/** A new tab in the same profile, as after closing the app and coming back. */
export async function comeBack(someone: Person): Promise<Person> {
  await someone.page.close()
  const page = await someone.context.newPage()
  page.on("pageerror", (error) => {
    console.log(`[${someone.name}] page error: ${error.message}`)
  })
  return { ...someone, page }
}

export function editor(page: Page): Locator {
  return page.locator('[aria-label="Main content area, start typing to enter text."]')
}

export async function type(someone: Person, text: string): Promise<void> {
  const area = editor(someone.page)
  await expect(area).toHaveAttribute("contenteditable", "true")
  await area.click()
  await someone.page.keyboard.press("End")
  await someone.page.keyboard.type(text)
}

/** Returns the notebook's id, read off the address bar. */
export async function createNotebook(owner: Person, title: string): Promise<string> {
  const { page } = owner
  await page.goto("/")
  await page.locator("#notebook-name").fill(title)
  await page.locator("#your-name").fill(owner.name)
  await page.getByRole("button", { name: /Create notebook/ }).click()
  await page.getByRole("button", { name: /Open notebook/ }).click()
  await page.waitForURL(/\/nb\/[^/]+/)
  await expect(editor(page)).toBeVisible()
  return new URL(page.url()).pathname.split("/")[2]
}

function membersDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Who can see this notebook" })
}

async function openMembers(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Who can see this notebook" }).first().click()
  const dialog = membersDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function closeMembers(page: Page): Promise<void> {
  await membersDialog(page).getByRole("button", { name: "Close" }).first().click()
  await expect(membersDialog(page)).toBeHidden()
}

export async function invite(owner: Person, label: string): Promise<{ link: string; code: string }> {
  const { page } = owner
  const dialog = await openMembers(page)
  await dialog.getByRole("button", { name: /Invite someone/ }).click()
  await page.locator("#invite-label").fill(label)
  await page.getByRole("button", { name: "Create invitation" }).click()
  const link = (await page.getByLabel("Joining link").textContent())?.trim() ?? ""
  const code = (await page.getByLabel("One-time code", { exact: true }).textContent())?.trim() ?? ""
  await page.getByRole("button", { name: "Done" }).click()
  await closeMembers(page)
  return { link, code }
}

/** Opens the link, enters the code, and returns the device code to read out to the owner. */
export async function askToJoin(member: Person, link: string, code: string): Promise<string> {
  const { page } = member
  await page.goto(new URL(link).pathname)
  await page.getByLabel("One-time code").fill(code)
  const ask = page.getByRole("button", { name: "Ask to join" })
  await expect(ask).toBeEnabled({ timeout: 30_000 })
  await ask.click()
  await expect(page.getByRole("heading", { name: "Waiting to be let in" })).toBeVisible()
  const deviceCode = page.getByLabel("Your device code")
  await expect(deviceCode).not.toHaveText("…")
  return (await deviceCode.textContent())?.trim() ?? ""
}

/**
 * The owner compares the device code they were read, then admits - and waits
 * until the notes are readable to the new member, which is what an owner
 * about to close the app has to wait for.
 */
export async function admit(owner: Person, deviceCode: string): Promise<void> {
  const { page } = owner
  const dialog = await openMembers(page)
  await dialog.getByRole("button", { name: "Review" }).click({ timeout: 30_000 })
  await page.locator("#approve-redemption-code").fill(deviceCode)
  await page.getByRole("button", { name: "Admit" }).click()
  await expect(dialog.getByText("2 members")).toBeVisible()
  await expect(dialog.getByText(/notes are readable to them|Nothing needed covering/)).toBeVisible({
    timeout: 30_000,
  })
  await closeMembers(page)
}

/** A real PNG, small and solid, built without a canvas. */
export function aPng(width = 48, height = 32, rgb: [number, number, number] = [200, 80, 40]): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export async function addImage(someone: Person, name: string, png: Buffer): Promise<void> {
  await editor(someone.page).click()
  await someone.page.keyboard.press("End")
  await someone.page
    .locator('input[type="file"][accept*="image"]:not([webkitdirectory])')
    .first()
    .setInputFiles({ name, mimeType: "image/png", buffer: png })
  await expect(editor(someone.page).locator("img")).toHaveCount(1)
}

/** Whether every image in the note has actually loaded, not just been placed. */
export async function imagesShown(page: Page): Promise<number> {
  return editor(page)
    .locator("img")
    .evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length)
}

/** Waits to be let in, then opens the notebook. */
export async function enter(member: Person): Promise<void> {
  const { page } = member
  await expect(page.getByRole("heading", { name: "You are in." })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("link", { name: "Open the notebook" }).click()
  await page.waitForURL(/\/nb\//)
  await expect(editor(page)).toBeVisible()
}

export async function remove(owner: Person, label: string): Promise<void> {
  const { page } = owner
  const dialog = await openMembers(page)
  await dialog.getByRole("button", { name: `Remove ${label}` }).click()
  const confirm = page.getByRole("dialog", { name: `Remove ${label}?` })
  await confirm.getByRole("button", { name: `Remove ${label}` }).click()
  await expect(dialog.getByText("1 member")).toBeVisible()
  await closeMembers(page)
}
