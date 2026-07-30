// Some handy predicate helpers for menu routing

import type { MenuContext } from "./menu-types";
import { TextSelection } from "@tiptap/pm/state";

export const TOOLBAR_SEL = '[data-tt-role="toolbar"], .tt-toolbar';
export const TABBAR_SEL   = '[data-tt-role="tabbar"], .tab-bar';
export const SIDEPANEL_SEL= '[data-tt-role="sidepanel"], .side-panel, .side-panel-row';
export const EDITOR_SEL     = '[data-tt-role="editor"], .simple-editor-content';
export const EDITOR_PANEL_SEL = '.simple-editor-main';

export const whenNode = (typeName: string) => (ctx: MenuContext) =>
  ctx.node?.type?.name === typeName;

export const whenAnyPathIncludes = (typeName: string) => (ctx: MenuContext) =>
  ctx.pathTypes?.includes(typeName) ?? false;

export const whenMark = (markName: string) => (ctx: MenuContext) =>
  (ctx.activeMarks ?? []).some(m => m.type.name === markName);

export const whenDomMatches = (selector: string) => (ctx: MenuContext) =>
  !!ctx.domTarget && (ctx.domTarget.closest?.(selector) ? true : false);

export const when = (...preds: Array<(c: MenuContext) => boolean>) =>
  (ctx: MenuContext) => preds.every(p => p(ctx));

export const whenAnySelection = () => (ctx: MenuContext) =>
  !!ctx.editor && !ctx.editor.state.selection.empty;

export const whenTextSelection = () => (ctx: MenuContext) => {
  const sel = ctx.editor?.state.selection;
  return !!sel && sel instanceof TextSelection && !sel.empty;
};

export const whenToolbar = whenDomMatches(TOOLBAR_SEL);
export const whenTabbar    = whenDomMatches(TABBAR_SEL);
export const whenSidepanel = whenDomMatches(SIDEPANEL_SEL);

// UI chrome = any non-editor chrome area
export const whenUIChrome = (ctx: MenuContext) =>
  whenToolbar(ctx) || whenTabbar(ctx) || whenSidepanel(ctx);

// editor area = not UI chrome
export const whenEditor = (ctx: MenuContext) =>
  !!ctx.domTarget?.closest?.(EDITOR_SEL) &&
  !whenToolbar(ctx) && !whenTabbar(ctx) && !whenSidepanel(ctx);

export const whenEditorPanel = (ctx: MenuContext) =>
  !!ctx.domTarget?.closest?.(EDITOR_PANEL_SEL) &&
  !ctx.domTarget?.closest?.(EDITOR_SEL) &&
  !whenToolbar(ctx) && !whenTabbar(ctx) && !whenSidepanel(ctx);
