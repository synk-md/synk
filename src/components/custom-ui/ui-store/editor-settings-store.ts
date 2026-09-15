import { useSyncExternalStore } from "react"

export const lineWidths = [
  { id: "narrow", name: "Narrow", width: "600px" },
  { id: "medium", name: "Medium", width: "720px" },
  { id: "wide", name: "Wide", width: "960px" },
  { id: "full", name: "Full width", width: "none" },
] as const
export type LineWidth = typeof lineWidths[number]["id"]
type EditorSettings = { spellcheck: boolean; fontSize: number; lineWidth: LineWidth }
const KEY = "tt:editorSettings"
const defaults: EditorSettings = { spellcheck: false, fontSize: 16, lineWidth: "medium" }
function read(): EditorSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return {
      spellcheck: typeof saved?.spellcheck === "boolean" ? saved.spellcheck : defaults.spellcheck,
      fontSize: [14, 16, 18, 20].includes(saved?.fontSize) ? saved.fontSize : defaults.fontSize,
      lineWidth: lineWidths.find(item => item.id === saved?.lineWidth)?.id ?? defaults.lineWidth,
    }
  } catch { return defaults }
}
let settings = read()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setEditorSettings(patch: Partial<EditorSettings>) {
  settings = { ...settings, ...patch }
  localStorage.setItem(KEY, JSON.stringify(settings))
  listeners.forEach(listener => listener())
}
export function useEditorSettings() {
  return useSyncExternalStore(subscribe, () => settings)
}
