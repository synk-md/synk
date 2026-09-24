import { beforeEach, describe, expect, it } from "vitest"

import {
  initCurrentDevice,
  resetCurrentDevice,
  resetDeviceIdentityCache,
  currentDevice,
} from "@/lib/identity"
import { createNotebookIndexDoc, evictNotebookIndexDoc } from "@/lib/yjs-utils"

import { claimNewNotebook } from "./claim"
import { genesisClaims, readNotebookWorkspace } from "./notebook-workspace"

const NOTEBOOK = "claimtest"

beforeEach(async () => {
  evictNotebookIndexDoc(NOTEBOOK)
  resetCurrentDevice()
  resetDeviceIdentityCache()
  await initCurrentDevice()
})

describe("claiming a new notebook", () => {
  it("founds the workspace in the notebook's own index document", async () => {
    await claimNewNotebook(NOTEBOOK, "Travel")

    const { doc } = createNotebookIndexDoc(NOTEBOOK)
    const workspace = await readNotebookWorkspace({
      doc,
      notebookId: NOTEBOOK,
      selfDid: currentDevice()?.identity.did,
    })

    expect(workspace.ownership.status).toBe("established")
    expect(workspace.ownership.owner).toBe(currentDevice()?.identity.did)
    expect(workspace.self).not.toBeNull()
  })

  /** Ownership is only unambiguous at creation, so a repeat must not add a claim. */
  it("does not add a second claim when called again", async () => {
    await claimNewNotebook(NOTEBOOK, "Travel")
    await claimNewNotebook(NOTEBOOK, "Travel")

    const { doc } = createNotebookIndexDoc(NOTEBOOK)
    expect(genesisClaims(doc)).toHaveLength(1)
  })

  it("does nothing without a device identity, rather than throwing", async () => {
    resetCurrentDevice()

    await expect(claimNewNotebook(NOTEBOOK, "Travel")).resolves.toBeUndefined()

    const { doc } = createNotebookIndexDoc(NOTEBOOK)
    expect(genesisClaims(doc)).toHaveLength(0)
  })
})
