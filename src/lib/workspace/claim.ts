/**
 * Founding a notebook's workspace from the app.
 *
 * Only ever called for a notebook this device is creating. Founding on first
 * *open* would be simpler and wrong: an already-shared notebook has no genesis
 * yet, so whichever device opened it first would claim ownership of someone
 * else's notebook, and every other device would then see a disputed workspace.
 *
 * Notebooks that predate this therefore stay unowned until somebody claims one
 * deliberately. `readNotebookWorkspace` reports that as `none`, which is the
 * honest state rather than a broken one.
 */

import { currentDevice } from "@/lib/identity"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

import { foundNotebookKeys } from "./notebook-keys"
import { foundNotebookWorkspace } from "./notebook-workspace"

export async function claimNewNotebook(
  notebookId: string,
  label: string,
): Promise<void> {
  const device = currentDevice()
  if (!device) return

  const { doc, idb } = createNotebookIndexDoc(notebookId)
  // The genesis has to land in the same stored document the tree lives in, so
  // wait for the store rather than racing it.
  await idb.whenSynced
  await foundNotebookWorkspace({
    doc,
    notebookId,
    device: device.identity,
    label,
  })
  // The key domain comes with the workspace: a notebook whose owner is
  // established but which has no genesis epoch has nothing to seal content
  // under, and every later membership change would have no timeline to cut.
  await foundNotebookKeys({ doc, notebookId, device: device.identity })
}
