/**
 * Which devices are this device's own: grouped with it as one person.
 */

import type * as Y from "yjs"

import type { DeviceIdentity, DeviceRecord } from "@/lib/identity"

import { readNotebookWorkspace } from "./notebook-workspace"

/**
 * Everyone grouped with this device as one person in a notebook it is in -
 * except any device one of its notebooks took out, so that unlinking a lost
 * phone is not undone by a notebook the unlinking did not reach. A device
 * linked under one taken out with it is not taken out itself: it just is not
 * there, so a person removed from someone else's notebook keeps their phone.
 */
export async function ownDevicesIn(
  device: DeviceIdentity,
  notebooks: readonly { doc: Y.Doc; notebookId: string }[],
): Promise<Map<string, DeviceRecord>> {
  const own = new Map<string, DeviceRecord>()
  const out = new Set<string>()
  for (const { doc, notebookId } of notebooks) {
    const workspace = await readNotebookWorkspace({ doc, notebookId, selfDid: device.did })
    for (const did of workspace.directory?.removed ?? []) out.add(did)
    const me = workspace.users.find((user) => user.devices.some((entry) => entry.record.did === device.did))
    for (const entry of me?.devices ?? []) if (entry.record.did !== device.did) own.set(entry.record.did, entry.record)
  }
  for (const did of out) own.delete(did)
  return own
}
