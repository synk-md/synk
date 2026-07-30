import { describe, expect, it } from "vitest"
import { TextSelection, NodeSelection, type Selection } from "@tiptap/pm/state"
import {
  whenNode,
  whenAnyPathIncludes,
  whenMark,
  whenDomMatches,
  when,
  whenAnySelection,
  whenTextSelection,
  whenUIChrome,
  whenEditor,
  whenEditorPanel,
  TOOLBAR_SEL,
} from "./predicates"
import type { MenuContext } from "./menu-types"
import { visible, enabled, active, type MenuItem } from "./menu-types"

function ctx(overrides: Partial<MenuContext> = {}): MenuContext {
  return { x: 0, y: 0, editor: undefined as never, ...overrides }
}

function fakeSelection(kind: "text" | "node" | "other", empty: boolean): Selection {
  if (kind === "text") return Object.create(TextSelection.prototype, { empty: { value: empty } })
  if (kind === "node") return Object.create(NodeSelection.prototype, { empty: { value: empty } })
  return { empty } as Selection
}

function editorWithSelection(selection: Selection) {
  return { state: { selection } } as MenuContext["editor"]
}

describe("whenNode", () => {
  it("matches when the clicked node's type name equals the target", () => {
    const pred = whenNode("image")
    expect(pred(ctx({ node: { type: { name: "image" } } as any }))).toBe(true)
    expect(pred(ctx({ node: { type: { name: "paragraph" } } as any }))).toBe(false)
  })

  it("is false when there's no node", () => {
    expect(whenNode("image")(ctx())).toBe(false)
  })
})

describe("whenAnyPathIncludes", () => {
  it("matches when the ancestor path contains the type name", () => {
    const pred = whenAnyPathIncludes("tableCell")
    expect(pred(ctx({ pathTypes: ["doc", "table", "tableCell"] }))).toBe(true)
    expect(pred(ctx({ pathTypes: ["doc", "paragraph"] }))).toBe(false)
  })

  it("is false when pathTypes is missing", () => {
    expect(whenAnyPathIncludes("tableCell")(ctx())).toBe(false)
  })
})

describe("whenMark", () => {
  it("matches when one of the active marks has the given type name", () => {
    const pred = whenMark("bold")
    expect(pred(ctx({ activeMarks: [{ type: { name: "bold" } } as any] }))).toBe(true)
    expect(pred(ctx({ activeMarks: [{ type: { name: "italic" } } as any] }))).toBe(false)
  })

  it("is false when there are no active marks", () => {
    expect(whenMark("bold")(ctx())).toBe(false)
  })
})

describe("whenDomMatches", () => {
  it("matches when the DOM target (or an ancestor) matches the selector", () => {
    const child = document.createElement("span")
    const parent = document.createElement("div")
    parent.className = "tt-toolbar"
    parent.appendChild(child)

    expect(whenDomMatches(".tt-toolbar")(ctx({ domTarget: child }))).toBe(true)
  })

  it("is false when there's no dom target or no match", () => {
    expect(whenDomMatches(".tt-toolbar")(ctx())).toBe(false)
    const div = document.createElement("div")
    expect(whenDomMatches(".tt-toolbar")(ctx({ domTarget: div }))).toBe(false)
  })
})

describe("when", () => {
  it("is true only when every predicate passes", () => {
    const always = () => true
    const never = () => false
    expect(when(always, always)(ctx())).toBe(true)
    expect(when(always, never)(ctx())).toBe(false)
  })

  it("is vacuously true with no predicates", () => {
    expect(when()(ctx())).toBe(true)
  })
})

describe("whenAnySelection", () => {
  it("is true when there's a non-empty selection", () => {
    const editor = editorWithSelection(fakeSelection("other", false))
    expect(whenAnySelection()(ctx({ editor }))).toBe(true)
  })

  it("is false for an empty selection or missing editor", () => {
    const editor = editorWithSelection(fakeSelection("other", true))
    expect(whenAnySelection()(ctx({ editor }))).toBe(false)
    expect(whenAnySelection()(ctx({ editor: undefined as never }))).toBe(false)
  })
})

describe("whenTextSelection", () => {
  it("is true only for a non-empty TextSelection", () => {
    const editor = editorWithSelection(fakeSelection("text", false))
    expect(whenTextSelection()(ctx({ editor }))).toBe(true)
  })

  it("is false for an empty TextSelection or a non-text selection", () => {
    expect(whenTextSelection()(ctx({ editor: editorWithSelection(fakeSelection("text", true)) }))).toBe(false)
    expect(whenTextSelection()(ctx({ editor: editorWithSelection(fakeSelection("node", false)) }))).toBe(false)
  })
})

describe("whenUIChrome / whenEditor / whenEditorPanel", () => {
  function domTargetIn(html: string): HTMLElement {
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)
    return container.querySelector("[data-target]") as HTMLElement
  }

  it("whenUIChrome is true inside toolbar/tabbar/sidepanel chrome", () => {
    const target = domTargetIn(`<div class="tt-toolbar"><span data-target></span></div>`)
    expect(whenUIChrome(ctx({ domTarget: target }))).toBe(true)
  })

  it("whenEditor is true inside the editor content area and false inside chrome", () => {
    const editorTarget = domTargetIn(
      `<div class="simple-editor-content"><span data-target></span></div>`,
    )
    expect(whenEditor(ctx({ domTarget: editorTarget }))).toBe(true)

    const chromeTarget = domTargetIn(
      `<div class="simple-editor-content tt-toolbar"><span data-target></span></div>`,
    )
    expect(whenEditor(ctx({ domTarget: chromeTarget }))).toBe(false)
  })

  it("whenEditorPanel is true in the editor's main panel but outside the editor content/chrome", () => {
    const panelTarget = domTargetIn(
      `<div class="simple-editor-main"><span data-target></span></div>`,
    )
    expect(whenEditorPanel(ctx({ domTarget: panelTarget }))).toBe(true)

    const contentTarget = domTargetIn(
      `<div class="simple-editor-main"><div class="simple-editor-content"><span data-target></span></div></div>`,
    )
    expect(whenEditorPanel(ctx({ domTarget: contentTarget }))).toBe(false)
  })

  it("TOOLBAR_SEL is exported for reuse by callers", () => {
    expect(TOOLBAR_SEL).toContain("toolbar")
  })
})

describe("menu-types guards (visible/enabled/active)", () => {
  it("default to true/true/false when unset", () => {
    const item: MenuItem = { id: "x" }
    expect(visible(item, ctx())).toBe(true)
    expect(enabled(item, ctx())).toBe(true)
    expect(active(item, ctx())).toBe(false)
  })

  it("delegate to the item's predicate when set", () => {
    const item: MenuItem = {
      id: "x",
      isVisible: () => false,
      isEnabled: () => false,
      isActive: () => true,
    }
    expect(visible(item, ctx())).toBe(false)
    expect(enabled(item, ctx())).toBe(false)
    expect(active(item, ctx())).toBe(true)
  })
})
