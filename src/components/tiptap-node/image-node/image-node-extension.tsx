import * as React from "react"
import { mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"
import type { Node as ProsemirrorNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, Selection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { RiFileDamageLine } from "@remixicon/react"
import type { Awareness } from "y-protocols/awareness"

import "@/components/tiptap-node/image-node/image-node.scss"

export type AssetImageOptions = {
  HTMLAttributes: Record<string, unknown>
  resolveAsset: (assetId: string, name?: string | null) => Promise<Blob | null>
  upload?: (
    file: File,
    onProgress?: (event: { progress: number }) => void,
    abortSignal?: AbortSignal
  ) => Promise<{ assetId: string }>
  // When set, broadcasts the locally selected image over Yjs awareness and
  // renders an outline on images other collaborators currently have selected.
  awareness?: Awareness | null
}

// Exported so other extensions (e.g. CollaborationCaret's render override)
// can recognize when a collaborator's cursor position is really an image
// selection rather than a text position.
export const SELECTION_AWARENESS_FIELD = "synkImageSelection"

const imageSelectionPluginKey = new PluginKey("imageSelectionAwareness")

// Identifies the exact node a collaborator selected, not just which asset it
// renders — two nodes can share an `assetId` (the same image pasted twice),
// and only the one actually selected should be highlighted.
type ImageSelectionState = { assetId: string; pos: number } | null

function buildImageSelectionDecorations(doc: ProsemirrorNode, awareness: Awareness): DecorationSet {
  const decorations: Decoration[] = []

  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return
    const selection = (state as Record<string, unknown>)[SELECTION_AWARENESS_FIELD] as ImageSelectionState
    if (!selection) return

    const node = doc.nodeAt(selection.pos)
    if (!node || node.type.name !== "image" || node.attrs.assetId !== selection.assetId) return

    const user = (state as Record<string, unknown>).user as { color?: string; name?: string } | undefined
    decorations.push(
      Decoration.node(selection.pos, selection.pos + node.nodeSize, {
        "data-collab-selection-color": user?.color ?? "#ffa500",
        "data-collab-selection-name": user?.name ?? "Someone",
      })
    )
  })

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

const MIN_SIZE = 40

type HandleId =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left"

type HandleConfig = {
  id: HandleId
  signX: -1 | 0 | 1
  signY: -1 | 0 | 1
  corner: boolean
}

const RESIZE_HANDLES: HandleConfig[] = [
  { id: "top-left", signX: -1, signY: -1, corner: true },
  { id: "top", signX: 0, signY: -1, corner: false },
  { id: "top-right", signX: 1, signY: -1, corner: true },
  { id: "right", signX: 1, signY: 0, corner: false },
  { id: "bottom-right", signX: 1, signY: 1, corner: true },
  { id: "bottom", signX: 0, signY: 1, corner: false },
  { id: "bottom-left", signX: -1, signY: 1, corner: true },
  { id: "left", signX: -1, signY: 0, corner: false },
]

type Size = { width: number; height: number }

function AssetImageNodeView({ node, extension, selected, updateAttributes, decorations }: NodeViewProps) {
  const collabSelection = decorations
    .map((decoration) => decoration.type.attrs as Record<string, string | undefined>)
    .find((attrs) => attrs["data-collab-selection-color"])

  const { assetId, alt, title, width, height, align } = node.attrs as {
    assetId: string | null
    alt: string | null
    title: string | null
    width: number | null
    height: number | null
    align: "left" | "center" | "right"
  }
  const [src, setSrc] = React.useState<string | null>(null)
  const [unavailable, setUnavailable] = React.useState(false)
  const [previewSize, setPreviewSize] = React.useState<Size | null>(null)
  const figureRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null

    setSrc(null)
    setUnavailable(false)

    if (!assetId) {
      setUnavailable(true)
      return
    }

    void (extension.options as AssetImageOptions)
      .resolveAsset(assetId, title ?? alt)
      .then((blob) => {
        if (disposed) return
        if (!blob) {
          setUnavailable(true)
          return
        }

        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch((error) => {
        if (!disposed) {
          console.error(`Failed to resolve image asset ${assetId}:`, error)
          setUnavailable(true)
        }
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // `extension.options` is a getter that returns a new object on every
    // access, so depend on the (stable) extension instance instead.
  }, [assetId, extension])

  const handleResizeStart = React.useCallback(
    (handle: HandleConfig) => (event: React.PointerEvent) => {
      // Only the primary (left) button drags a handle; right/middle clicks
      // (e.g. to open the context menu) must pass through untouched.
      if (event.button !== 0) return
      event.preventDefault()
      const figure = figureRef.current
      if (!figure) return

      const startX = event.clientX
      const startY = event.clientY
      const startRect = figure.getBoundingClientRect()
      const startWidth = startRect.width
      const startHeight = startRect.height

      // The figure's `max-width: 100%` resolves against its parent's
      // *content* box, not the parent's bounding rect — which also includes
      // the editor's own horizontal padding. Clamping to the padded rect
      // would let width grow past what CSS actually allows to render, while
      // the height (scaled from that too-generous width) keeps growing,
      // producing a visibly stretched image once CSS clamps the width.
      const parent = figure.parentElement
      let maxWidth = startWidth
      if (parent) {
        const parentRect = parent.getBoundingClientRect()
        const parentStyle = window.getComputedStyle(parent)
        const horizontalPadding =
          parseFloat(parentStyle.paddingLeft || "0") + parseFloat(parentStyle.paddingRight || "0")
        maxWidth = parentRect.width - horizontalPadding
      }

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX
        const dy = moveEvent.clientY - startY

        let nextWidth = startWidth
        let nextHeight = startHeight

        if (handle.corner) {
          // Corners scale both dimensions uniformly, driven by horizontal movement.
          nextWidth = Math.min(
            Math.max(startWidth + handle.signX * dx, MIN_SIZE),
            maxWidth
          )
          const scale = nextWidth / startWidth
          nextHeight = Math.max(startHeight * scale, MIN_SIZE)
        } else if (handle.signX !== 0) {
          // Left/right edges resize width only, distorting the aspect ratio.
          nextWidth = Math.min(
            Math.max(startWidth + handle.signX * dx, MIN_SIZE),
            maxWidth
          )
        } else {
          // Top/bottom edges resize height only, distorting the aspect ratio.
          nextHeight = Math.max(startHeight + handle.signY * dy, MIN_SIZE)
        }

        setPreviewSize({ width: Math.round(nextWidth), height: Math.round(nextHeight) })
      }

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove)
        window.removeEventListener("pointerup", handlePointerUp)
        setPreviewSize((finalSize) => {
          if (finalSize) updateAttributes({ width: finalSize.width, height: finalSize.height })
          return null
        })
      }

      window.addEventListener("pointermove", handlePointerMove)
      window.addEventListener("pointerup", handlePointerUp)
    },
    [updateAttributes]
  )

  const displayWidth = previewSize?.width ?? width ?? undefined
  const displayHeight = previewSize?.height ?? height ?? undefined

  return (
    <NodeViewWrapper
      as="figure"
      className={`asset-image-node asset-image-node--align-${align ?? "left"}${
        collabSelection ? " asset-image-node--collab-selected" : ""
      }`}
      data-asset-id={assetId ?? undefined}
      data-drag-handle
      ref={figureRef}
      style={{
        width: displayWidth,
        height: displayHeight,
        "--collab-selection-color": collabSelection?.["data-collab-selection-color"],
      } as React.CSSProperties}
    >
      {collabSelection ? (
        <div className="asset-image-collab-label">
          {collabSelection["data-collab-selection-name"]}
        </div>
      ) : null}
      {src ? (
        <img
          src={src}
          alt={alt ?? ""}
          title={title ?? undefined}
          draggable={false}
          style={displayHeight ? { width: "100%", height: "100%" } : undefined}
        />
      ) : unavailable ? (
        <div className="asset-image-placeholder asset-image-placeholder--broken" role="status">
          <RiFileDamageLine />
          <span>Image unavailable</span>
        </div>
      ) : (
        <div className="asset-image-placeholder" role="status">
          Loading image…
        </div>
      )}
      {selected && src
        ? RESIZE_HANDLES.map((handle) => (
            <span
              key={handle.id}
              className={`asset-image-resize-handle asset-image-resize-handle--${handle.id}`}
              onPointerDown={handleResizeStart(handle)}
            />
          ))
        : null}
    </NodeViewWrapper>
  )
}

export const AssetImage = Node.create<AssetImageOptions>({
  name: "image",

  group: "block",

  draggable: true,

  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      resolveAsset: async () => null,
      upload: undefined,
      awareness: null,
    }
  },

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element) => {
          const direct = element.getAttribute("data-asset-id")
          if (direct) return direct

          const src = element.getAttribute("src")
          return src?.startsWith("asset:") ? src.slice("asset:".length) : null
        },
      },
      alt: {
        default: null,
      },
      title: {
        default: null,
      },
      width: {
        default: null,
        parseHTML: (element) => {
          const value = element.style.width || element.getAttribute("width")
          const parsed = value ? parseInt(value, 10) : NaN
          return Number.isNaN(parsed) ? null : parsed
        },
      },
      height: {
        default: null,
        parseHTML: (element) => {
          const value = element.style.height || element.getAttribute("height")
          const parsed = value ? parseInt(value, 10) : NaN
          return Number.isNaN(parsed) ? null : parsed
        },
      },
      align: {
        default: "left",
        parseHTML: (element) => {
          const value = element.getAttribute("data-align")
          return value === "center" || value === "right" ? value : "left"
        },
      },
    }
  },

  parseHTML() {
    return [
      { tag: "img[data-asset-id]" },
      { tag: 'img[src^="asset:"]' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const { assetId, alt, title, width, height, align } = HTMLAttributes
    const style = [width ? `width: ${width}px` : null, height ? `height: ${height}px` : null]
      .filter(Boolean)
      .join("; ")
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, {
        "data-asset-id": assetId,
        alt,
        title,
        "data-align": align && align !== "left" ? align : undefined,
        style: style || undefined,
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetImageNodeView)
  },

  addKeyboardShortcuts() {
    return {
      // Puts the actual image bytes on the system clipboard (instead of
      // ProseMirror's default HTML/text serialization) so the image can be
      // pasted into other apps, not just back into this editor.
      "Mod-c": ({ editor }) => {
        const { selection } = editor.state
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== this.name) {
          return false
        }

        const assetId = selection.node.attrs.assetId as string | null
        if (!assetId) return false

        const { resolveAsset } = this.options
        void resolveAsset(assetId, selection.node.attrs.title ?? selection.node.attrs.alt)
          .then((blob) => {
            if (!blob) throw new Error("Image unavailable")
            // The ClipboardItem's key must match the blob's actual MIME type,
            // or the browser rejects the write.
            return navigator.clipboard.write([
              new ClipboardItem({ [blob.type || "image/png"]: blob }),
            ])
          })
          .catch((error) => console.error("Failed to copy image to clipboard:", error))

        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const upload = this.options.upload
    const nodeName = this.name
    const awareness = this.options.awareness

    const plugins = [
      // Clicking anywhere outside the currently-selected image — including
      // outside the editor entirely (sidebar, toolbar, etc.) — drops its
      // NodeSelection so it stops looking "stuck" as selected.
      new Plugin({
        view(editorView) {
          const handleDocumentMouseDown = (event: MouseEvent) => {
            const { state } = editorView
            const sel = state.selection
            if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return

            // Don't deselect for clicks on UI that's meant to act on the
            // current selection (the context menu, or toolbar buttons like
            // the alignment controls) — only "actually clicking elsewhere"
            // should drop it.
            const target = event.target as globalThis.Node | null
            if (
              target &&
              (target as HTMLElement).closest?.('#tt-context-menu, [data-tt-role="toolbar"]')
            ) {
              return
            }

            const imageDom = editorView.nodeDOM(sel.from) as HTMLElement | null
            if (imageDom && target && imageDom.contains(target)) return

            // Search for a *text* position only (the `true` arg). Without
            // it, `findFrom` happily returns a NodeSelection on the next
            // atom it finds — so deselecting one image while a second one
            // sits right after it (no paragraph in between) would just
            // select that second image instead of actually deselecting.
            const next =
              Selection.findFrom(state.doc.resolve(sel.to), 1, true) ??
              Selection.findFrom(state.doc.resolve(sel.from), -1, true) ??
              Selection.atStart(state.doc)
            editorView.dispatch(state.tr.setSelection(next))
          }

          document.addEventListener("mousedown", handleDocumentMouseDown, true)
          return {
            destroy() {
              document.removeEventListener("mousedown", handleDocumentMouseDown, true)
            },
          }
        },
      }),

      // Pasting an image (e.g. a screenshot, or one copied from another app)
      // uploads it as an asset and inserts it at the cursor, instead of
      // falling through to the browser's default text/html paste.
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            if (!upload) return false

            const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
              file.type.startsWith("image/")
            )
            if (files.length === 0) return false

            event.preventDefault()

            const editor = this.editor
            void Promise.all(files.map((file) => upload(file)))
              .then((assets) => {
                const nodes = assets.map((asset, index) => {
                  const filename = files[index].name.replace(/\.[^/.]+$/, "") || "image"
                  return {
                    type: nodeName,
                    attrs: { assetId: asset.assetId, alt: filename, title: filename },
                  }
                })
                editor.chain().focus().insertContent(nodes).run()
              })
              .catch((error) => console.error("Failed to paste image:", error))

            return true
          },

          // Dragging an asset row in from the explorer's Assets folder reuses
          // the asset already stored locally — no upload needed, just insert
          // a node pointing at the same assetId.
          handleDrop: (view, event) => {
            const assetData = event.dataTransfer?.getData("application/x-synk-asset")
            if (assetData) {
              let parsed: { assetId: string; name?: string } | null = null
              try {
                parsed = JSON.parse(assetData)
              } catch {
                parsed = null
              }

              if (parsed?.assetId) {
                event.preventDefault()

                const dropPos =
                  view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
                  view.state.selection.from
                const filename = parsed.name?.replace(/\.[^/.]+$/, "") || "image"

                this.editor
                  .chain()
                  .focus()
                  .insertContentAt(dropPos, {
                    type: nodeName,
                    attrs: { assetId: parsed.assetId, alt: filename, title: filename },
                  })
                  .run()

                return true
              }
            }

            // Dragging image files in from the OS file explorer (rather than
            // moving content already inside the editor) uploads them and
            // inserts them at the drop position.
            if (!upload) return false

            const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
              file.type.startsWith("image/")
            )
            if (files.length === 0) return false

            event.preventDefault()

            const dropPos =
              view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
              view.state.selection.from

            const editor = this.editor
            void Promise.all(files.map((file) => upload(file)))
              .then((assets) => {
                const nodes = assets.map((asset, index) => {
                  const filename = files[index].name.replace(/\.[^/.]+$/, "") || "image"
                  return {
                    type: nodeName,
                    attrs: { assetId: asset.assetId, alt: filename, title: filename },
                  }
                })
                editor.chain().focus().insertContentAt(dropPos, nodes).run()
              })
              .catch((error) => console.error("Failed to drop image:", error))

            return true
          },
        },
      }),
    ]

    if (awareness) {
      plugins.push(
        // Broadcasts the locally selected image to other collaborators via
        // Yjs awareness, and renders an outline on images that other
        // collaborators currently have selected.
        new Plugin({
          key: imageSelectionPluginKey,
          state: {
            init: (_, state) => buildImageSelectionDecorations(state.doc, awareness),
            apply(tr, old, _oldState, newState) {
              if (tr.docChanged || tr.getMeta(imageSelectionPluginKey)) {
                return buildImageSelectionDecorations(newState.doc, awareness)
              }
              return old.map(tr.mapping, tr.doc)
            },
          },
          props: {
            decorations(state) {
              return imageSelectionPluginKey.getState(state)
            },
          },
          view(editorView) {
            const updateLocalSelection = () => {
              const { selection } = editorView.state
              const next: ImageSelectionState =
                selection instanceof NodeSelection &&
                selection.node.type.name === nodeName &&
                selection.node.attrs.assetId
                  ? { assetId: selection.node.attrs.assetId as string, pos: selection.from }
                  : null

              const current = awareness.getLocalState()?.[
                SELECTION_AWARENESS_FIELD
              ] as ImageSelectionState
              if (current?.assetId !== next?.assetId || current?.pos !== next?.pos) {
                awareness.setLocalStateField(SELECTION_AWARENESS_FIELD, next)
              }
            }

            const handleAwarenessChange = () => {
              editorView.dispatch(editorView.state.tr.setMeta(imageSelectionPluginKey, true))
            }

            updateLocalSelection()
            awareness.on("change", handleAwarenessChange)

            return {
              update: updateLocalSelection,
              destroy() {
                awareness.off("change", handleAwarenessChange)
                awareness.setLocalStateField(SELECTION_AWARENESS_FIELD, null)
              },
            }
          },
        })
      )
    }

    return plugins
  },
})

export default AssetImage
