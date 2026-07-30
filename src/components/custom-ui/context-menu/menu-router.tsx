import type { MenuSpec, MenuContext, MenuItem } from "./menu-types";

export type MenuRoute<Ctx = MenuContext> = {
  id: string;
  when: (ctx: Ctx) => boolean;
  spec: MenuSpec<Ctx>;
  priority?: number; // higher first
};

function materialize<Ctx>(spec: MenuSpec<Ctx>, ctx: Ctx): MenuItem<Ctx>[] {
  return typeof spec === "function" ? spec(ctx) : spec;
}

// Find matching route with ctx predicate, else fallback
export function resolveSpec<Ctx>(
  routes: MenuRoute<Ctx>[],
  fallback: MenuSpec<Ctx>,
  ctx: Ctx
): MenuItem<Ctx>[] {
  const sorted = [...routes].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const route = sorted.find(r => r.when(ctx));
  return materialize(route ? route.spec : fallback, ctx);
}
