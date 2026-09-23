import { admittedDevices, type MemberDevice, type User } from "@/lib/identity"

export type SelfLinkStatus =
  | { level: "ok"; admittedCount: number }
  | { level: "last-one"; admittedCount: 1 }
  | { level: "stranded"; admittedCount: 0 }

/**
 * Would this leave the member unable to add devices?
 *
 * Only admin-approved devices can approve a new one; links are non-delegable
 * leaves. So a member holding nothing but linked devices cannot add another,
 * and getting back requires an admin. Computed against the set *after* the
 * proposed removal, because warning afterwards is useless.
 */
export function selfLinkStatus(user: User, removing?: MemberDevice): SelfLinkStatus {
  const remaining = removing
    ? { ...user, devices: user.devices.filter((d) => d.record.did !== removing.record.did) }
    : user
  const count = admittedDevices(remaining).length

  if (count === 0) return { level: "stranded", admittedCount: 0 }
  if (count === 1) return { level: "last-one", admittedCount: 1 }
  return { level: "ok", admittedCount: count }
}
