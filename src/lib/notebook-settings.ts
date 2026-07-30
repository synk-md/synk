import type * as Y from "yjs"

export type NotebookSettings = {
  theme?: "light" | "dark" | "system"
  enabledPlugins?: string[]
  lastOpenedNoteId?: string | null
}

export function readNotebookSettings(settings: Y.Map<any>): NotebookSettings {
  return {
    theme: settings.get("theme") ?? "system",
    enabledPlugins: settings.get("enabledPlugins") ?? [],
    lastOpenedNoteId: settings.get("lastOpenedNoteId") ?? null,
  }
}

export function updateNotebookSettings(settings: Y.Map<any>, patch: Partial<NotebookSettings>) {
  for (const [k, v] of Object.entries(patch)) {
    settings.set(k, v as any)
  }
}
