// src/ui/toolbar-store.ts
import * as React from "react";

type Listener = () => void;

const TOOLBAR_VISIBLE_KEY = "tt:toolbarVisible";
const INLINE_TITLE_VISIBLE_KEY = "tt:inlineTitleVisible";

const store = {
  visible: (() => {
    const saved = localStorage.getItem(TOOLBAR_VISIBLE_KEY);
    return saved == null ? true : saved === "1";
  })(),
  inlineTitleVisible: (() => {
    const saved = localStorage.getItem(INLINE_TITLE_VISIBLE_KEY);
    return saved == null ? true : saved === "1";
  })(),
  listeners: new Set<Listener>(),
};

export function getToolbarVisible() {
  return store.visible;
}

export function setToolbarVisible(v: boolean) {
  if (store.visible === v) return;
  store.visible = v;
  localStorage.setItem(TOOLBAR_VISIBLE_KEY, v ? "1" : "0");
  store.listeners.forEach((fn) => fn());
}

export function getInlineTitleVisible() {
  return store.inlineTitleVisible;
}

export function setInlineTitleVisible(v: boolean) {
  if (store.inlineTitleVisible === v) return;
  store.inlineTitleVisible = v;
  localStorage.setItem(INLINE_TITLE_VISIBLE_KEY, v ? "1" : "0");
  store.listeners.forEach((fn) => fn());
}

/** React hook for components that need to render based on visibility */
export function useToolbarVisible() {
  const [v, setV] = React.useState(getToolbarVisible());
  React.useEffect(() => {
    const l = () => setV(getToolbarVisible());
    store.listeners.add(l);
    return () => {
      store.listeners.delete(l);
    };
  }, []);
  return v;
}

export function useInlineTitleVisible() {
  const [v, setV] = React.useState(getInlineTitleVisible());
  React.useEffect(() => {
    const l = () => setV(getInlineTitleVisible());
    store.listeners.add(l);
    return () => {
      store.listeners.delete(l);
    };
  }, []);
  return v;
}
