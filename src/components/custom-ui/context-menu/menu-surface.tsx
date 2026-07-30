import * as React from "react";

import { Card, CardBody } from "@/components/tiptap-ui-primitive/card";
import { Button } from "@/components/tiptap-ui-primitive/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/tiptap-ui-primitive/dropdown-menu";
import { Separator } from "@/components/tiptap-ui-primitive/separator";

import { ChevronDownIcon as ChevronRightIcon } from "@/components/tiptap-icons/chevron-down-icon";

import type { MenuSpec, MenuContext, MenuItem } from "./menu-types";
import { visible, enabled, active } from "./menu-types";

type MenuSurfaceProps<Ctx = MenuContext> = {
  spec: MenuSpec<Ctx>;
  ctx: Ctx;
  onClose: () => void;
  cardStyle?: React.CSSProperties;
};

export function MenuSurface<Ctx = MenuContext>({ spec, ctx, onClose, cardStyle }: MenuSurfaceProps<Ctx>) {
  const items = (typeof spec === "function" ? spec(ctx) : spec) ?? [];
  const topLevel = items.filter(item => visible(item, ctx));

  return (
    <Card style={{ borderRadius: 10, ...cardStyle }}>
      <CardBody className="tt-card-body">
        <MenuList items={topLevel} ctx={ctx} onClose={onClose} />
      </CardBody>
    </Card>
  );
}

function MenuList<Ctx>({
  items,
  ctx,
  onClose,
}: {
  items: MenuItem<Ctx>[];
  ctx: Ctx;
  onClose: () => void;
}) {
  return (
    <div className="tt-menu-list" style={{ display: "flex", flexDirection: "column", minWidth: 200 }}>
      {items.map((it) => {
        if (!visible(it, ctx)) return null;
        return (
          <React.Fragment key={it.id}>
            {it.separatorBefore && (
              <Separator orientation="horizontal" decorative className="tt-separator" />
            )}
            <MenuRow item={it} ctx={ctx} onClose={onClose} />
            {it.separatorAfter && (
              <Separator orientation="horizontal" decorative className="tt-separator" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function MenuRow<Ctx>({
  item,
  ctx,
  onClose,
}: {
  item: MenuItem<Ctx>;
  ctx: Ctx;
  onClose: () => void;
}) {
  const isEnabled = enabled(item, ctx);
  const isActive = active(item, ctx);
  const hasChildren = !!item.children?.length;

  // Custom row (e.g., ListDropdownMenu)
  if (item.render) {
    const node = typeof item.render === "function" ? item.render(ctx, { close: onClose }) : item.render;
    return item.noWrap ? (
      <>{node}</>
    ) : (
      <div className="tt-context-custom" data-allow-focus style={{ padding: 6 }}>
        {node}
      </div>
    );
  }

  if (hasChildren) {
    return <SubmenuRow item={item} ctx={ctx} onClose={onClose} />;
  }

  // Leaf action
  return (
    <Button
      type="button"
      data-style="ghost"
      data-active-state={isActive ? "on" : "off"}
      disabled={!isEnabled}
      onClick={async () => {
        if (!isEnabled) return;
        await item.run?.(ctx);
        if (item.closeOnRun !== false) onClose();
      }}
      style={{
        justifyContent: "flex-start",
        padding: "8px 10px",
        borderRadius: 8,
        opacity: isEnabled ? 1 : 0.5,
        ...(item.dangerous ? { color: "var(--tt-red-600)" } : null),
      }}
    >
      {item.icon && <span className="tt-icon">{item.icon}</span>}
      {item.label}
      {item.shortcut && (
        <kbd style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>{item.shortcut}</kbd>
      )}
    </Button>
  );
}

function SubmenuRow<Ctx>({
  item,
  ctx,
  onClose,
}: {
  item: MenuItem<Ctx>;
  ctx: Ctx;
  onClose: () => void;
}) {
  const [subOpen, setSubOpen] = React.useState(false);
  const openT = React.useRef<number | null>(null);
  const closeT = React.useRef<number | null>(null);

  // NEW: used to ignore the next close coming from a click on the trigger while open
  const squelchClose = React.useRef(false);

  const OPEN_MS = item.hoverOpenDelayMs ?? 250;
  const CLOSE_MS = item.hoverCloseDelayMs ?? 150;

  const clearTimers = () => {
    if (openT.current) { window.clearTimeout(openT.current); openT.current = null; }
    if (closeT.current) { window.clearTimeout(closeT.current); closeT.current = null; }
  };

  const scheduleOpen = () => {
    if (subOpen) return;
    if (closeT.current) { window.clearTimeout(closeT.current); closeT.current = null; }
    openT.current = window.setTimeout(() => setSubOpen(true), OPEN_MS);
  };

  const scheduleClose = () => {
    if (openT.current) { window.clearTimeout(openT.current); openT.current = null; }
    closeT.current = window.setTimeout(() => setSubOpen(false), CLOSE_MS);
  };

  React.useEffect(() => clearTimers, []);

  return (
    <DropdownMenu
      open={subOpen}
      onOpenChange={(next) => {
        // If a click on the trigger was suppressed, ignore the resulting "close"
        if (!next && squelchClose.current) {
          squelchClose.current = false;
          return;
        }
        setSubOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          data-style="ghost"
          data-allow-focus
          aria-expanded={subOpen}
          style={{ justifyContent: "space-between", padding: "8px 10px", borderRadius: 8 }}

          // Hover: open/close after delays
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}

          // IMPORTANT: When already open, clicking the trigger should do nothing
          onPointerDown={(e) => {
            if (subOpen) {
              squelchClose.current = true;      // tell onOpenChange to ignore the close
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onClick={(e) => {
            if (subOpen) {
              e.preventDefault();
              e.stopPropagation();               // no toggle when already open
            } else {
              // allow click to open when closed (Radix will handle it)
            }
          }}

          // Keyboard niceties: keep open on Enter/Space if already open
          onKeyDown={(e) => {
            if (subOpen && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              e.stopPropagation();
            }
            if (e.key === "ArrowRight" || e.key === "Enter") setSubOpen(true);
            if (e.key === "ArrowLeft" || e.key === "Escape") setSubOpen(false);
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {item.icon && <span className="tt-icon">{item.icon}</span>}
            {item.label}
          </span>
          <span className="tt-caret" aria-hidden style={{ transform: "rotate(-90deg)" }}>
            <ChevronRightIcon className="tiptap-button-dropdown-small" />
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="tt-context-menu"
        align="start"
        side="right"
        sideOffset={6}
        portal={false}
        // Keep open while pointer is inside; close after delay when leaving
        onPointerEnter={() => {
          if (closeT.current) { window.clearTimeout(closeT.current); closeT.current = null; }
        }}
        onPointerLeave={scheduleClose}
      >
        <Card>
          <CardBody className="tt-card-body">
            <MenuList items={item.children!} ctx={ctx} onClose={onClose} />
          </CardBody>
        </Card>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
