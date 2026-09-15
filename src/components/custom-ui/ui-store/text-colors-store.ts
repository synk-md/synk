import { useSyncExternalStore } from "react"

export type TextColors = { title: string | null; subtitle: string | null }
const KEY = "tt:textColors"
const defaults: TextColors = { title: null, subtitle: null }
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
function read(): TextColors {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    // Older preferences stored two colors; keep the title color when combining them.
    const value = isColor(saved?.title) ? saved.title : isColor(saved?.subtitle) ? saved.subtitle : null
    return { title: value, subtitle: value }
  } catch { return defaults }
}
let colors = read()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function applyTextColors() {
  for (const key of ["title", "subtitle"] as const) {
    const value = colors[key]
    if (value) document.documentElement.style.setProperty(`--custom-${key}-color`, value)
    else document.documentElement.style.removeProperty(`--custom-${key}-color`)
  }
}
export function setTextColor(value: string | null) {
  if (value !== null && !isColor(value)) return
  colors = { title: value, subtitle: value }
  localStorage.setItem(KEY, JSON.stringify(colors))
  applyTextColors()
  listeners.forEach(listener => listener())
}
export function useTextColors() {
  return useSyncExternalStore(subscribe, () => colors)
}
