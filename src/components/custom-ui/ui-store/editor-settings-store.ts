import { useSyncExternalStore } from "react"

export const lineWidths = [
  { id: "narrow", name: "Narrow", width: "600px" },
  { id: "medium", name: "Medium", width: "720px" },
  { id: "wide", name: "Wide", width: "960px" },
  { id: "full", name: "Full width", width: "none" },
] as const
export type LineWidth = typeof lineWidths[number]["id"]
const ITALIC_WEIGHTS = "ital,wght@0,400;0,500;0,700;1,400;1,500;1,700"
// `load` is the Google Fonts family query; fonts without it are bundled in editor.scss or come from the OS.
export const editorFonts = [
  { id: "dm-sans", name: "DM Sans", group: "Sans-serif", family: '"DM Sans", sans-serif' },
  { id: "inter", name: "Inter", group: "Sans-serif", family: '"Inter", sans-serif' },
  { id: "system", name: "System default", group: "Sans-serif", family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "arial", name: "Arial", group: "Sans-serif", family: 'Arial, "Liberation Sans", Helvetica, sans-serif' },
  { id: "atkinson", name: "Atkinson Hyperlegible", group: "Sans-serif", family: '"Atkinson Hyperlegible", sans-serif', load: `Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700` },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", group: "Sans-serif", family: '"IBM Plex Sans", sans-serif', load: `IBM+Plex+Sans:${ITALIC_WEIGHTS}` },
  { id: "lato", name: "Lato", group: "Sans-serif", family: '"Lato", sans-serif', load: "Lato:ital,wght@0,400;0,700;1,400;1,700" },
  { id: "nunito", name: "Nunito", group: "Sans-serif", family: '"Nunito", sans-serif', load: `Nunito:${ITALIC_WEIGHTS}` },
  { id: "open-sans", name: "Open Sans", group: "Sans-serif", family: '"Open Sans", sans-serif', load: `Open+Sans:${ITALIC_WEIGHTS}` },
  { id: "roboto", name: "Roboto", group: "Sans-serif", family: '"Roboto", sans-serif', load: `Roboto:${ITALIC_WEIGHTS}` },
  { id: "source-sans", name: "Source Sans 3", group: "Sans-serif", family: '"Source Sans 3", sans-serif', load: `Source+Sans+3:${ITALIC_WEIGHTS}` },
  { id: "crimson-pro", name: "Crimson Pro", group: "Serif", family: '"Crimson Pro", serif', load: `Crimson+Pro:${ITALIC_WEIGHTS}` },
  { id: "eb-garamond", name: "EB Garamond", group: "Serif", family: '"EB Garamond", serif', load: `EB+Garamond:${ITALIC_WEIGHTS}` },
  { id: "literata", name: "Literata", group: "Serif", family: '"Literata", serif', load: `Literata:${ITALIC_WEIGHTS}` },
  { id: "lora", name: "Lora", group: "Serif", family: '"Lora", serif', load: `Lora:${ITALIC_WEIGHTS}` },
  { id: "merriweather", name: "Merriweather", group: "Serif", family: '"Merriweather", serif', load: "Merriweather:ital,wght@0,400;0,700;1,400;1,700" },
  { id: "source-serif", name: "Source Serif 4", group: "Serif", family: '"Source Serif 4", serif', load: `Source+Serif+4:${ITALIC_WEIGHTS}` },
  { id: "times-new-roman", name: "Times New Roman", group: "Serif", family: '"Times New Roman", "Liberation Serif", Times, serif' },
  { id: "fira-code", name: "Fira Code", group: "Monospace", family: '"Fira Code", monospace', load: "Fira+Code:wght@400;500;700" },
  { id: "ibm-plex-mono", name: "IBM Plex Mono", group: "Monospace", family: '"IBM Plex Mono", monospace', load: `IBM+Plex+Mono:${ITALIC_WEIGHTS}` },
  { id: "jetbrains-mono", name: "JetBrains Mono", group: "Monospace", family: '"JetBrains Mono", monospace', load: `JetBrains+Mono:${ITALIC_WEIGHTS}` },
] as const satisfies readonly { id: string; name: string; group: string; family: string; load?: string }[]
export type EditorFont = typeof editorFonts[number]["id"]
export const editorFontGroups = [...new Set(editorFonts.map(font => font.group))]

function loadFont(id: EditorFont) {
  const font = editorFonts.find(item => item.id === id)
  if (!font || !("load" in font) || document.querySelector(`link[data-editor-font="${id}"]`)) return
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = `https://fonts.googleapis.com/css2?family=${font.load}&display=swap`
  link.dataset.editorFont = id
  document.head.appendChild(link)
}
type EditorSettings = { spellcheck: boolean; fontSize: number; lineWidth: LineWidth; font: EditorFont }
const KEY = "tt:editorSettings"
const defaults: EditorSettings = { spellcheck: false, fontSize: 16, lineWidth: "medium", font: "dm-sans" }
function read(): EditorSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return {
      spellcheck: typeof saved?.spellcheck === "boolean" ? saved.spellcheck : defaults.spellcheck,
      fontSize: [14, 16, 18, 20].includes(saved?.fontSize) ? saved.fontSize : defaults.fontSize,
      lineWidth: lineWidths.find(item => item.id === saved?.lineWidth)?.id ?? defaults.lineWidth,
      font: editorFonts.find(item => item.id === saved?.font)?.id ?? defaults.font,
    }
  } catch { return defaults }
}
let settings = read()
loadFont(settings.font)
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setEditorSettings(patch: Partial<EditorSettings>) {
  settings = { ...settings, ...patch }
  if (patch.font) loadFont(patch.font)
  localStorage.setItem(KEY, JSON.stringify(settings))
  listeners.forEach(listener => listener())
}
export function useEditorSettings() {
  return useSyncExternalStore(subscribe, () => settings)
}
