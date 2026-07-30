import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { Editor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { AssetImage } from "@/components/tiptap-node/image-node/image-node-extension"

const { storeImageAsset } = vi.hoisted(() => ({ storeImageAsset: vi.fn() }))
vi.mock("@/lib/image-assets", () => ({ storeImageAsset }))

import {
  cn,
  isMac,
  formatShortcutKey,
  parseShortcutKeys,
  isValidPosition,
  isAllowedUri,
  sanitizeUrl,
  isMarkInSchema,
  isNodeInSchema,
  isExtensionAvailable,
  isNodeTypeSelected,
  findNodeAtPosition,
  findNodePosition,
  focusNextNode,
  handleImageUpload,
  MAX_FILE_SIZE,
} from "./tiptap-utils"

describe("cn", () => {
  it("joins truthy class values with a space", () => {
    expect(cn("a", "b", null, undefined, false, "c")).toBe("a b c")
  })

  it("returns an empty string when nothing is truthy", () => {
    expect(cn(false, null, undefined)).toBe("")
  })
})

describe("isMac", () => {
  const originalPlatform = navigator.platform

  afterEach(() => {
    Object.defineProperty(navigator, "platform", { value: originalPlatform, configurable: true })
  })

  it("is true when navigator.platform mentions Mac", () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
    expect(isMac()).toBe(true)
  })

  it("is false otherwise", () => {
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true })
    expect(isMac()).toBe(false)
  })
})

describe("formatShortcutKey", () => {
  it("maps modifier names to Mac symbols on Mac", () => {
    expect(formatShortcutKey("mod", true)).toBe("⌘")
    expect(formatShortcutKey("ctrl", true)).toBe("⌃")
    expect(formatShortcutKey("shift", true)).toBe("⇧")
  })

  it("capitalizes unrecognized keys on Mac", () => {
    expect(formatShortcutKey("k", true)).toBe("K")
    expect(formatShortcutKey("k", true, false)).toBe("k")
  })

  it("capitalizes the first letter on non-Mac platforms", () => {
    expect(formatShortcutKey("ctrl", false)).toBe("Ctrl")
    expect(formatShortcutKey("ctrl", false, false)).toBe("ctrl")
  })
})

describe("parseShortcutKeys", () => {
  it("splits on the delimiter and formats each key", () => {
    expect(parseShortcutKeys({ shortcutKeys: "ctrl+shift+k", capitalize: false })).toEqual(
      isMac() ? ["⌃", "⇧", "k"] : ["ctrl", "shift", "k"],
    )
  })

  it("supports a custom delimiter and trims whitespace", () => {
    expect(parseShortcutKeys({ shortcutKeys: "ctrl - k", delimiter: "-", capitalize: false })).toEqual(
      isMac() ? ["⌃", "k"] : ["ctrl", "k"],
    )
  })

  it("returns an empty array for undefined/empty input", () => {
    expect(parseShortcutKeys({ shortcutKeys: undefined })).toEqual([])
    expect(parseShortcutKeys({ shortcutKeys: "" })).toEqual([])
  })
})

describe("isValidPosition", () => {
  it("is true for non-negative numbers, including 0", () => {
    expect(isValidPosition(0)).toBe(true)
    expect(isValidPosition(5)).toBe(true)
  })

  it("is false for negative numbers, null, undefined, or non-numbers", () => {
    expect(isValidPosition(-1)).toBe(false)
    expect(isValidPosition(null)).toBe(false)
    expect(isValidPosition(undefined)).toBe(false)
  })
})

describe("isAllowedUri", () => {
  it("allows the built-in safe protocols", () => {
    for (const uri of [
      "https://example.com",
      "http://example.com",
      "mailto:person@example.com",
      "tel:+15555550100",
      "ftp://files.example.com",
    ]) {
      expect(isAllowedUri(uri)).toBeTruthy()
    }
  })

  it("allows protocol-relative and root-relative URLs", () => {
    expect(isAllowedUri("/relative/path")).toBeTruthy()
    expect(isAllowedUri("#anchor")).toBeTruthy()
    expect(isAllowedUri("just-a-word")).toBeTruthy()
  })

  it("rejects dangerous script-executing protocols", () => {
    expect(isAllowedUri("javascript:alert(1)")).toBeFalsy()
    expect(isAllowedUri("vbscript:msgbox(1)")).toBeFalsy()
    expect(isAllowedUri("data:text/html,<script>alert(1)</script>")).toBeFalsy()
  })

  it("allows undefined/empty uris (nothing to sanitize)", () => {
    expect(isAllowedUri(undefined)).toBeTruthy()
    expect(isAllowedUri("")).toBeTruthy()
  })

  it("honors additional allowed protocols passed in", () => {
    expect(isAllowedUri("myapp:open")).toBeFalsy()
    expect(isAllowedUri("myapp:open", ["myapp"])).toBeTruthy()
    expect(isAllowedUri("myapp:open", [{ scheme: "myapp" }])).toBeTruthy()
  })

  it("strips embedded whitespace/control characters before matching (a common bypass)", () => {
    // "java\tscript:" with a tab in the middle is a classic filter-bypass trick.
    expect(isAllowedUri("java\tscript:alert(1)")).toBeFalsy()
  })
})

describe("sanitizeUrl", () => {
  it("resolves a relative url against the base and returns the absolute href", () => {
    expect(sanitizeUrl("/path", "https://example.com")).toBe("https://example.com/path")
  })

  it("passes through an already-absolute allowed url", () => {
    expect(sanitizeUrl("https://example.com/x", "https://base.com")).toBe("https://example.com/x")
  })

  it("returns '#' for a disallowed protocol", () => {
    expect(sanitizeUrl("javascript:alert(1)", "https://example.com")).toBe("#")
  })

  it("returns '#' when the URL can't be constructed at all", () => {
    expect(sanitizeUrl("http://[::::]", "not a valid base")).toBe("#")
  })
})

describe("schema/editor helpers (against a real headless editor)", () => {
  const editor = new Editor({
    editable: false,
    extensions: [StarterKit.configure({ undoRedo: false }), AssetImage],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "image", attrs: { assetId: "sha256:1" } },
      ],
    },
  })

  afterEach(() => {
    // Selections set in one test shouldn't leak into the next.
    editor.commands.setTextSelection(1)
  })

  it("isMarkInSchema / isNodeInSchema reflect the editor's actual schema", () => {
    expect(isMarkInSchema("bold", editor)).toBe(true)
    expect(isMarkInSchema("nonexistentMark", editor)).toBe(false)
    expect(isNodeInSchema("paragraph", editor)).toBe(true)
    expect(isNodeInSchema("nonexistentNode", editor)).toBe(false)
  })

  it("isMarkInSchema / isNodeInSchema are false without an editor", () => {
    expect(isMarkInSchema("bold", null)).toBe(false)
    expect(isNodeInSchema("paragraph", null)).toBe(false)
  })

  it("isExtensionAvailable checks the editor's registered extensions", () => {
    expect(isExtensionAvailable(editor, "bold")).toBe(true)
    expect(isExtensionAvailable(editor, ["missing", "bold"])).toBe(true)
    expect(isExtensionAvailable(editor, "missing")).toBe(false)
    expect(isExtensionAvailable(null, "bold")).toBe(false)
  })

  it("findNodeAtPosition finds the node at a position, or null out of range", () => {
    expect(findNodeAtPosition(editor, 0)?.type.name).toBe("paragraph")
    expect(findNodeAtPosition(editor, 99999)).toBeNull()
  })

  it("findNodePosition finds a node by identity or falls back to a given position", () => {
    const target = editor.state.doc.nodeAt(0)!
    expect(findNodePosition({ editor, node: target })).toEqual({ pos: 0, node: target })
    expect(findNodePosition({ editor, nodePos: 0 })?.node.type.name).toBe("paragraph")
    expect(findNodePosition({ editor: null, nodePos: 0 })).toBeNull()
    expect(findNodePosition({ editor })).toBeNull()
  })

  it("isNodeTypeSelected is true only for a NodeSelection of a matching type", () => {
    let imagePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos
    })
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imagePos)))
    expect(isNodeTypeSelected(editor, ["image"])).toBe(true)
    expect(isNodeTypeSelected(editor, ["paragraph"])).toBe(false)

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
    expect(isNodeTypeSelected(editor, ["image"])).toBe(false)
  })

  it("isNodeTypeSelected is false without an editor or with an empty selection", () => {
    expect(isNodeTypeSelected(null, ["image"])).toBe(false)
  })

  it("focusNextNode moves the selection to the next valid position when one exists", () => {
    // A fresh editor, since prior mutations to the shared `editor` fixture
    // (including tiptap's own trailing-paragraph normalization on first
    // dispatch) make absolute positions order-dependent otherwise.
    const soloEditor = new Editor({
      editable: false,
      extensions: [StarterKit.configure({ undoRedo: false }), AssetImage],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          { type: "image", attrs: { assetId: "sha256:1" } },
        ],
      },
    })
    // Select the trailing image node (the boundary right after the
    // paragraph), so there's a genuine "next" position to move into.
    const imagePos = soloEditor.state.doc.content.size - 1
    soloEditor.view.dispatch(
      soloEditor.state.tr.setSelection(TextSelection.near(soloEditor.state.doc.resolve(imagePos), 1)),
    )
    const posBefore = soloEditor.state.selection.to

    const moved = focusNextNode(soloEditor)

    expect(moved).toBe(true)
    expect(soloEditor.state.selection.to).toBeGreaterThan(posBefore)
    soloEditor.destroy()
  })
})

describe("handleImageUpload", () => {
  beforeEach(() => {
    storeImageAsset.mockReset()
  })

  it("rejects when no file is provided", async () => {
    await expect(handleImageUpload(null as unknown as File)).rejects.toThrow("No file provided")
  })

  it("rejects a file larger than MAX_FILE_SIZE without reading it", async () => {
    const bigFile = new File([new Uint8Array(MAX_FILE_SIZE + 1)], "big.png", { type: "image/png" })
    await expect(handleImageUpload(bigFile)).rejects.toThrow(/exceeds maximum/)
    expect(storeImageAsset).not.toHaveBeenCalled()
  })

  it("stores the file and reports 100% progress on success", async () => {
    storeImageAsset.mockResolvedValue({ assetId: "sha256:abc" })
    const file = new File(["small image bytes"], "small.png", { type: "image/png" })
    const onProgress = vi.fn()

    const result = await handleImageUpload(file, onProgress)

    expect(result).toEqual({ assetId: "sha256:abc" })
    expect(onProgress).toHaveBeenCalledWith({ progress: 100 })
  })

  it("rejects when storeImageAsset fails", async () => {
    storeImageAsset.mockRejectedValue(new Error("disk full"))
    const file = new File(["bytes"], "small.png", { type: "image/png" })

    await expect(handleImageUpload(file)).rejects.toThrow("disk full")
  })

  it("rejects immediately if the abort signal is already aborted before the read completes", async () => {
    storeImageAsset.mockResolvedValue({ assetId: "sha256:abc" })
    const file = new File(["bytes"], "small.png", { type: "image/png" })
    const controller = new AbortController()
    controller.abort()

    await expect(handleImageUpload(file, undefined, controller.signal)).rejects.toThrow(/cancelled/)
  })
})
