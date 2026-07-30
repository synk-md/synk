import * as React from "react";
import type { Editor } from "@tiptap/react";
import type { MenuSpec, MenuContext } from "./menu-types";
import { MenuSurface } from "./menu-surface";

// PM selection helpers
import { NodeSelection, TextSelection, Selection } from "@tiptap/pm/state";

import "./context-menu.scss";

type Props = {
  editor: Editor | null;
  spec: MenuSpec;
  container?: HTMLElement | null;
  autoClose?: boolean;
  extraContext?: Partial<MenuContext>;
};

function getAtomAtPos(doc: any, pos: number) {
  const $pos = doc.resolve(pos);
  if ($pos.nodeAfter && $pos.nodeAfter.isAtom) {
    return { node: $pos.nodeAfter, pos: $pos.pos };
  }
  if ($pos.nodeBefore && $pos.nodeBefore.isAtom) {
    return { node: $pos.nodeBefore, pos: $pos.pos - $pos.nodeBefore.nodeSize };
  }
  return null;
}

// Resolves the exact doc position of an atom node from the DOM element that
// was actually clicked, by matching each atom node's rendered DOM (via the
// public `view.nodeDOM`) against it. This is immune to the screen-coordinate
// ambiguity of `posAtCoords`, which can snap to a neighboring node when the
// click lands on a NodeView's edge decoration (e.g. an image's resize handle).
function findAtomPosForDOM(view: any, dom: HTMLElement): number | null {
  let found: number | null = null;
  view.state.doc.descendants((node: any, pos: number) => {
    if (found !== null) return false;
    if (node.isAtom && view.nodeDOM(pos) === dom) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

export function ContextMenu({ editor, spec, container, autoClose = true, extraContext }: Props) {
  const [open, setOpen] = React.useState(false);
  const [ctx, setCtx] = React.useState<MenuContext | null>(null);
  const extraContextRef = React.useRef(extraContext);
  extraContextRef.current = extraContext;

  // 1) Keep selection when right-clicking inside an existing selection (capture phase)
  React.useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;

    const guard = (ev: MouseEvent) => {
      const isContext = ev.button === 2 || (ev.button === 0 && ev.ctrlKey); // macOS ctrl+click
      if (!isContext) return;

      const posAt = editor.view.posAtCoords({ left: ev.clientX, top: ev.clientY });
      const sel = editor.state.selection;
      if (posAt && !sel.empty && posAt.pos >= sel.from && posAt.pos <= sel.to) {
        ev.preventDefault(); // keep current selection
      }
    };

    el.addEventListener("mousedown", guard, true);
    return () => el.removeEventListener("mousedown", guard, true);
  }, [editor]);

  // 2) Close on outside click / Esc
  React.useEffect(() => {
    if (!open || !autoClose) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById("tt-context-menu");
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, autoClose]);

  // 3) Right-click handler (selection-safe + builds MenuContext)
  React.useEffect(() => {
    if (!editor) return;
    const view = editor.view;
    const target = container ?? view.dom;

    const handler = (e: MouseEvent) => {
      if (!target.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[data-tt-native-context-menu]")) return;
      e.preventDefault();

      

      // Prefer resolving the position from the clicked DOM element's own
      // NodeView (exact) over screen coordinates (approximate), so a click on
      // e.g. an image's resize handle still resolves to that exact image.
      const nodeViewDom = (e.target as HTMLElement)?.closest?.(
        "[data-node-view-wrapper]"
      ) as HTMLElement | null;
      const domResolvedPos = nodeViewDom ? findAtomPosForDOM(view, nodeViewDom) : null;

      const posAt = domResolvedPos == null ? view.posAtCoords({ left: e.clientX, top: e.clientY }) : null;
      const clickPos = domResolvedPos ?? posAt?.pos ?? null;

      // Keep selection if the click is inside it
      const sel = view.state.selection;
      const clickInsideSelection =
        !sel.empty && clickPos !== null && clickPos >= sel.from && clickPos <= sel.to;

      // Gather node + marks at click
      let node: any = null;
      let nodePos: number | null = null;
      let pathTypes: string[] = [];
      let activeMarks: any[] = [];

      if (clickPos !== null) {
        const $pos = view.state.doc.resolve(clickPos);
        node = $pos.nodeAfter || $pos.nodeBefore || null;
        nodePos = node ? (node === $pos.nodeAfter ? $pos.pos : $pos.pos - (node?.nodeSize ?? 0)) : null;
        for (let d = 0; d <= $pos.depth; d++) pathTypes.push($pos.node(d).type.name);
        try {
          activeMarks = [...($pos.marks?.() ?? [])];
        } catch {
          /* no-op */
        }
      }

      // Update selection only if needed
      const doc = view.state.doc;
      if (!clickInsideSelection && clickPos != null) {
        const clamped = Math.max(0, Math.min(clickPos, doc.content.size));

        // Atom node at/near pos? -> NodeSelection at its start
        const atom = getAtomAtPos(doc, clamped);
        if (atom) {
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, atom.pos)));
          view.focus();
        } else {
          // In textblock? -> simple caret selection
          const $pos = doc.resolve(clamped);
          if ($pos.parent.isTextblock) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, clamped)));
            view.focus();
          } else {
            // Otherwise find nearest valid selection (gap cursor / node / text)
            try {
              const near = Selection.near($pos, 1);
              view.dispatch(view.state.tr.setSelection(near));
            } catch {
              const end = doc.content.size;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, end)));
            }
            view.focus();
          }
        }
      }

      setCtx({
        editor,
        x: e.clientX,
        y: e.clientY,
        pos: clickPos ?? undefined,
        event: e,
        node,
        nodePos,
        pathTypes,
        activeMarks,
        domTarget: e.target as HTMLElement,
        ...extraContextRef.current,
      });
      setOpen(true);
    };

    target.addEventListener("contextmenu", handler);
    return () => target.removeEventListener("contextmenu", handler);
  }, [editor, container]);

  if (!editor || !open || !ctx) return null;



  return (
    <div
      id="tt-context-menu"
      className="tt-context-menu"
      style={{
        position: "fixed",
        top: ctx.y,
        left: ctx.x,
        transform: "translate(6px, 6px)",
        zIndex: 9999,
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        // keep editor focus unless a child explicitly opts in
        const allow = (e.target as HTMLElement).closest("[data-allow-focus]");
        if (!allow) e.preventDefault();
      }}
    >
      <MenuSurface spec={spec} ctx={ctx} onClose={() => setOpen(false)} />
    </div>
  );
}
