import type { Editor } from "@tiptap/react";
import type { Node as PMNode, Mark as PMMark } from "@tiptap/pm/model";

export type MenuContext = {
  editor: Editor;
  // Screen position of the click (for positioning)
  x: number;
  y: number;
  // ProseMirror document position under cursor, if available
  pos?: number;
  // The raw event in case you need it
  event?: MouseEvent;

  node?: PMNode | null; // node at click (nodeAfter || nodeBefore)
  nodePos?: number | null; // resloved position for NodeSelection if needed
  pathTypes?: string[]; // names of node types from root to clicked node
  activeMarks?: PMMark[]; // marks active at that pos
  domTarget?: HTMLElement | null; // raw DOM

  // App-level hook: opens the given asset (by its content-hash asset id) in
  // a note-editor tab, e.g. for an image's "Open in new tab" action.
  openAssetInTab?: (assetId: string) => void;

  // App-level hook: returns the active note's display title, e.g. for naming
  // a downloaded file.
  getActiveTitle?: () => string;
};

export type RunResult = void | Promise<void>;

export type MenuItemRenderer<Ctx> = (
  ctx: Ctx,
  api: { close: () => void }
) => React.ReactNode;

export type MenuItem<Ctx = MenuContext> = {
  render?: MenuItemRenderer<Ctx> | React.ReactNode | null;
  /** Unique id in its level */
  id: string;
  /** Text shown to the user */
  label?: string;
  /** Optional icon component or node */
  icon?: React.ReactNode;

  /** Execute when clicked */
  run?: (ctx: Ctx) => RunResult;

  /** Optional predicate hooks */
  isVisible?: (ctx: Ctx) => boolean; // default: true
  isEnabled?: (ctx: Ctx) => boolean; // default: true
  isActive?: (ctx: Ctx) => boolean;  // default: false

  /** Optional keyboard hint like "⌘B" */
  shortcut?: string;

  /** Close menu after run; default true */
  closeOnRun?: boolean;

  /** Mark destructive for styling */
  dangerous?: boolean;

  /** Child items = submenu */
  children?: MenuItem<Ctx>[];

  /** Divider line before this item */
  separatorBefore?: boolean;
  /** Divider line after this item */
  separatorAfter?: boolean;

  hoverOpenDelayMs?: number;
  hoverCloseDelayMs?: number;

  /** If true, don't wrap render() in the parent <div> */
  noWrap?: boolean;
};

export type MenuSpec<Ctx = MenuContext> =
  | MenuItem<Ctx>[]
  | ((ctx: Ctx) => MenuItem<Ctx>[]);

/** Basic guards with sensible defaults */
export function visible<Ctx>(item: MenuItem<Ctx>, ctx: Ctx) {
  return item.isVisible ? item.isVisible(ctx) : true;
}
export function enabled<Ctx>(item: MenuItem<Ctx>, ctx: Ctx) {
  return item.isEnabled ? item.isEnabled(ctx) : true;
}
export function active<Ctx>(item: MenuItem<Ctx>, ctx: Ctx) {
  return item.isActive ? item.isActive(ctx) : false;
}
