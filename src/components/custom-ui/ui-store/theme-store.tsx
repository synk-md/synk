import * as React from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "tt:theme";

const listeners = new Set<() => void>();
let theme: Theme = (localStorage.getItem(KEY) as Theme) || "system";

const mql = window.matchMedia?.("(prefers-color-scheme: dark)");

function systemPrefersDark() {
  return !!mql?.matches;
}

function apply(themeToApply: Theme) {
  const dark = themeToApply === "dark" || (themeToApply === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function bootTheme() {
  apply(theme);
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
