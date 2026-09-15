import * as React from "react";
import { applyTextColors } from "./text-colors-store";

export type Theme = "light" | "dark" | "system";
const KEY = "tt:theme";
const COLOR_KEY = "tt:colorTheme";
export const colorThemes = [
  { id: "classic", name: "Classic" },
  { id: "sandstone", name: "Sandstone" },
  { id: "forest", name: "Forest" },
  { id: "rose", name: "Rose" },
  { id: "ocean", name: "Ocean" },
] as const;
export type ColorTheme = typeof colorThemes[number]["id"];
const savedColorTheme = localStorage.getItem(COLOR_KEY);
let colorTheme: ColorTheme = colorThemes.find(item => item.id === savedColorTheme)?.id ?? "classic";

const listeners = new Set<() => void>();
let theme: Theme = (localStorage.getItem(KEY) as Theme) || "system";

const mql = window.matchMedia?.("(prefers-color-scheme: dark)");

function systemPrefersDark() {
  return !!mql?.matches;
}

function apply(themeToApply: Theme) {
  const dark = themeToApply === "dark" || (themeToApply === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.dataset.colorTheme = colorTheme;
}

export function bootTheme() {
  apply(theme);
  applyTextColors();
  if (mql) {
    mql.addEventListener("change", () => {
      if (theme === "system") apply(theme);
      listeners.forEach((l) => l());
    });
  }
}

export function getTheme(): Theme {
  return theme;
}

export function setTheme(next: Theme) {
  if (theme === next) return;
  theme = next;
  localStorage.setItem(KEY, next);
  apply(next);
  listeners.forEach((l) => l());
}

// React hook for components that want to render the current theme
export function useTheme() {
  const [t, setT] = React.useState<Theme>(() => getTheme());
  React.useEffect(() => {
    const l = () => setT(getTheme());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [t, setTheme] as const;
}

export function getColorTheme(): ColorTheme {
  return colorTheme;
}

export function setColorTheme(next: ColorTheme) {
  if (colorTheme === next) return;
  colorTheme = next;
  localStorage.setItem(COLOR_KEY, next);
  apply(theme);
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useColorTheme() {
  return [React.useSyncExternalStore(subscribe, getColorTheme), setColorTheme] as const;
}
