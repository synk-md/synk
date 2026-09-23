/**
 * What the sync states are called. Saved and shared are different questions: an
 * edit is durable the instant it is typed, so every offline state leads with
 * that and only then explains what is waiting.
 *
 * None of them calls being offline an error, because it is not one.
 */

import type { Route, SyncStatus } from "@/lib/relay"

export type StatusTone = "ok" | "busy" | "waiting" | "trouble"

export interface StatusCopy {
  tone: StatusTone
  /** Two or three words, next to an icon. */
  label: string
  detail: string
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${String(count)} ${many}`
}

export function routeLabel(route: Route): string {
  switch (route) {
    case "relay":
      return "through the sync server"
    case "peer":
      return "directly to another device"
    case "none":
      return "nowhere yet"
  }
}

export function statusCopy(status: SyncStatus): StatusCopy {
  const pending = status.pendingOutbound

  switch (status.phase) {
    case "caught-up":
      return {
        tone: "ok",
        label: "Up to date",
        detail: `Everything you have written is saved here and shared ${routeLabel(status.route)}.`,
      }

    case "syncing":
      return {
        tone: "busy",
        label: "Syncing",
        detail:
          pending > 0
            ? `Saved here. Sending ${plural(pending, "change", "changes")} ${routeLabel(status.route)}.`
            : "Saved here. Catching up with changes from other devices.",
      }

    case "offline-pending":
      return {
        tone: "waiting",
        label: "Offline",
        detail: `Saved on this device. ${plural(pending, "change", "changes")} will be shared when you reconnect — nothing is lost in the meantime.`,
      }

    case "offline-idle":
      return {
        tone: "waiting",
        label: "Offline",
        detail:
          "Saved on this device. You can keep working; changes are shared when a connection comes back.",
      }
  }
}

/** One of these the person can fix and the other they cannot. */
export function offlineReason(browserOnline: boolean): string | null {
  if (browserOnline) {
    return "Your device is connected, but the sync server cannot be reached. Editing is unaffected."
  }
  return "This device has no network connection."
}

export const LOCAL_FIRST_NOTE =
  "Your notes live on this device. The server only passes encrypted changes between your devices — it cannot read them, and it is never needed to open or edit anything."
