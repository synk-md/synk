import { useSyncExternalStore } from "react"

const KEY = "tt:zoom"
export const zoomLevels = [80, 90, 100, 110, 125, 150] as const
export type ZoomLevel = typeof zoomLevels[number]

const saved = Number(localStorage.getItem(KEY))
let zoom: ZoomLevel = zoomLevels.find(level => level === saved) ?? 100
const listeners = new Set<() => void>()

// Viewport units are scaled by `zoom` too, so styles divide them by --app-zoom to keep filling the window.
export function applyZoom() {
  const root = document.documentElement
  root.style.zoom = zoom === 100 ? "" : String(zoom / 100)
  root.style.setProperty("--app-zoom", String(zoom / 100))
}

export function getZoom(): ZoomLevel {
  return zoom
}

export function setZoom(next: ZoomLevel) {
  if (zoom === next) return
  zoom = next
  localStorage.setItem(KEY, String(next))
  applyZoom()
  listeners.forEach(listener => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useZoom() {
  return [useSyncExternalStore(subscribe, getZoom), setZoom] as const
}
