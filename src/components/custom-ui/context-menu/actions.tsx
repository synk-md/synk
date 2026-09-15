import type { MenuItem, MenuContext } from "./menu-types";
import { BoldIcon } from "@/components/tiptap-icons/bold-icon";
import { ItalicIcon } from "@/components/tiptap-icons/italic-icon";
import { UnderlineIcon } from "@/components/tiptap-icons/underline-icon";
import { LinkIcon } from "@/components/tiptap-icons/link-icon";
import { BanIcon } from "@/components/tiptap-icons/ban-icon";
import { Code2Icon } from "@/components/tiptap-icons/code2-icon";
import { TrashIcon } from "@/components/tiptap-icons/trash-icon";
import { ImagePlusIcon } from "@/components/tiptap-icons/image-plus-icon";
import { CopyIcon } from "@/components/tiptap-icons/copy-icon";
import { CutIcon } from "@/components/tiptap-icons/cut-icon";
import { PasteIcon } from "@/components/tiptap-icons/paste-icon";
import { ExternalLinkIcon } from "@/components/tiptap-icons/external-link-icon";
import { AlignLeftIcon } from "@/components/tiptap-icons/align-left-icon";
import { AlignCenterIcon } from "@/components/tiptap-icons/align-center-icon";
import { AlignRightIcon } from "@/components/tiptap-icons/align-right-icon";
import { RiMarkdownLine, RiBracesLine, RiFileTextLine, RiPencilLine } from "@remixicon/react";

import { Separator } from "@/components/tiptap-ui-primitive/separator"
import { isMac } from "@/lib/tiptap-utils"
import { downloadFile } from "@/lib/download-file"
import { getMarkdownContent } from "@/extensions/markdown-conversion"
import { requestLinkPopoverOpen } from "@/components/tiptap-ui/link-popover"
import { noteTitleFor, type NoteLinkOptions } from "@/components/tiptap-node/note-link-node/note-link-node-extension"

import "./context-menu.scss";

function getImageFigure(ctx: MenuContext): HTMLElement | null {
  return ctx.domTarget?.closest(".asset-image-node") ?? null;
}

function getImageElement(ctx: MenuContext): HTMLImageElement | null {
  return getImageFigure(ctx)?.querySelector("img") ?? null;
}

// Reads the asset id straight off the right-clicked image's own DOM node
// rather than ProseMirror's position-resolved node, so it can't drift to a
// neighboring image when multiple images sit in the same note.
function getImageAssetId(ctx: MenuContext): string | null {
  return getImageFigure(ctx)?.getAttribute("data-asset-id") ?? null;
}

async function copyImageToClipboard(ctx: MenuContext): Promise<boolean> {
  const img = getImageElement(ctx);
  if (!img?.src) return false;
  try {
    const blob = await (await fetch(img.src)).blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "image/png"]: blob }),
    ]);
    return true;
  } catch (e) {
    console.warn("Copy image failed:", e);
    return false;
  }
}

function deleteRightClickedImage(ctx: MenuContext) {
  const assetId = getImageAssetId(ctx);
  const { editor } = ctx;
  if (!assetId) return;

  let pos: number | null = null;
  editor.state.doc.descendants((node, p) => {
    if (pos !== null) return false;
    if (node.type.name === "image" && node.attrs.assetId === assetId) {
      pos = p;
      return false;
    }
    return true;
  });

  if (pos !== null) {
    editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
  }
}

// The upload function lives on the image node extension's options (same one
// used for drag/drop and keyboard paste), so reuse it here instead of
// threading a second copy of it through MenuContext.
function getImageUpload(ctx: MenuContext) {
  const extension = ctx.editor.extensionManager.extensions.find((e) => e.name === "image");
  return extension?.options?.upload as
    | ((file: File) => Promise<{ assetId: string }>)
    | undefined;
}

async function insertImageFromClipboardBlob(ctx: MenuContext, blob: Blob): Promise<boolean> {
  const upload = getImageUpload(ctx);
  if (!upload) return false;

  const file = new File([blob], "image", { type: blob.type || "image/png" });
  const asset = await upload(file);
  ctx.editor
    .chain()
    .focus()
    .insertContent({ type: "image", attrs: { assetId: asset.assetId, alt: "image", title: "image" } })
    .run();
  return true;
}

// The context menu resolves a right-clicked atom from its NodeView DOM, so
// `ctx.node`/`ctx.nodePos` are exactly the clicked note link.
function getNoteLink(ctx: MenuContext) {
  if (ctx.node?.type.name !== "noteLink" || ctx.nodePos == null) return null;
  return { node: ctx.node, pos: ctx.nodePos };
}

function getNoteLinkApi(ctx: MenuContext) {
  const extension = ctx.editor.extensionManager.extensions.find((e) => e.name === "noteLink");
  return (extension?.options as NoteLinkOptions | undefined)?.api() ?? null;
}

export const Actions = {
  placeholder(): MenuItem {
    return {
      id: "placeholder",
      label: "No actions available",
    };
  },
  bold(): MenuItem {
    return {
      id: "bold",
      label: "Bold",
      shortcut: isMac() ? "⌘B" : "Ctrl+B",
      icon: <BoldIcon className="tiptap-button-icon" />,
      run: ({ editor }) => editor.chain().focus().toggleBold().run() as any,
      isActive: ({ editor }) => editor.isActive("bold"),
      isEnabled: ({ editor }) => editor.can().toggleBold?.(),
    };
  },
  italic(): MenuItem {
    return {
      id: "italic",
      label: "Italic",
      shortcut: isMac() ? "⌘I" : "Ctrl+I",
      icon: <ItalicIcon className="tiptap-button-icon" />,
      run: ({ editor }) => editor.chain().focus().toggleItalic().run() as any,
      isActive: ({ editor }) => editor.isActive("italic"),
      isEnabled: ({ editor }) => editor.can().toggleItalic?.(),
    };
  },
  underline(): MenuItem {
    return {
      id: "underline",
      label: "Underline",
      shortcut: isMac() ? "⌘U" : "Ctrl+U",
      icon: <UnderlineIcon className="tiptap-button-icon" />,
      run: ({ editor }) => editor.chain().focus().toggleUnderline?.().run() as any,
      isActive: ({ editor }) => editor.isActive("underline"),
      isEnabled: ({ editor }) => !!editor.commands.toggleUnderline,
      isVisible: ({ editor }) => !!editor.extensionManager.extensions.find(e => e.name === "underline"),
    };
  },
  linkSet(): MenuItem {
    return {
      id: "link-set",
      label: "Add external link",
      icon: <LinkIcon className="tiptap-button-icon" />,
      // The popover applies the link to the current selection (or inserts the
      // URL as linked text at the caret) once a URL is entered.
      run: () => requestLinkPopoverOpen(),
      isEnabled: ({ editor }) => editor.can().setLink?.({ href: "https://example.com" }),
      isVisible: ({ editor }) => !editor.isActive("link"),
    };
  },
  linkEdit(): MenuItem {
    return {
      id: "link-edit",
      label: "Edit link",
      icon: <RiPencilLine className="tiptap-button-icon" />,
      run: () => requestLinkPopoverOpen(),
      isEnabled: ({ editor }) => editor.isEditable,
      isVisible: ({ editor }) => editor.isActive("link"),
    };
  },
  linkUnset(): MenuItem {
    return {
      id: "link-unset",
      label: "Remove link",
      icon: <BanIcon className="tiptap-button-icon" />,
      run: ({ editor }) => editor.chain().focus().unsetLink().run() as any,
      isVisible: ({ editor }) => editor.isActive("link"),
    };
  },
  noteLinkOpen(): MenuItem {
    return {
      id: "note-link-open",
      label: "Open note",
      icon: <ExternalLinkIcon className="tiptap-button-icon" />,
      isEnabled: (ctx) => {
        const noteId = getNoteLink(ctx)?.node.attrs.noteId as string | null;
        return !!noteTitleFor(getNoteLinkApi(ctx)?.tree ?? null, noteId);
      },
      run: (ctx) => {
        const noteId = getNoteLink(ctx)?.node.attrs.noteId as string | null;
        if (noteId) getNoteLinkApi(ctx)?.onNavigate(noteId);
      },
    };
  },
  noteLinkEdit(): MenuItem {
    return {
      id: "note-link-edit",
      label: "Edit link",
      icon: <RiPencilLine className="tiptap-button-icon" />,
      isEnabled: (ctx) => ctx.editor.isEditable && !!ctx.editNoteLink && !!getNoteLink(ctx),
      run: (ctx) => {
        const link = getNoteLink(ctx);
        if (link) ctx.editNoteLink?.(link.pos);
      },
    };
  },
  noteLinkUnset(): MenuItem {
    return {
      id: "note-link-unset",
      label: "Remove link",
      icon: <BanIcon className="tiptap-button-icon" />,
      isEnabled: (ctx) => ctx.editor.isEditable && !!getNoteLink(ctx),
      // Keeps the note's title in place as plain text, like removing an
      // external link keeps its text.
      run: (ctx) => {
        const link = getNoteLink(ctx);
        if (!link) return;
        const { node, pos } = link;
        const title =
          noteTitleFor(getNoteLinkApi(ctx)?.tree ?? null, node.attrs.noteId) ??
          (node.attrs.label as string | null) ??
          "Untitled";
        ctx.editor
          .chain()
          .focus()
          .command(({ tr, state }) => {
            tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(title));
            return true;
          })
          .run();
      },
    };
  },
  inlineCode(): MenuItem {
    return {
      id: "code",
      label: "Inline code",
      shortcut: isMac() ? "⌘E" : "Ctrl+E",
      icon: <Code2Icon className="tiptap-button-icon" />,
      run: ({ editor }) => editor.chain().focus().toggleCode().run() as any,
      isActive: ({ editor }) => editor.isActive("code"),
    };
  },
  imageCopy(): MenuItem {
    return {
      id: "image-copy",
      label: "Copy",
      icon: <CopyIcon className="tiptap-button-icon" />,
      isVisible: (ctx) => !!getImageFigure(ctx),
      isEnabled: (ctx) => !!getImageElement(ctx),
      run: (ctx) => copyImageToClipboard(ctx) as any,
    };
  },
  imageCut(): MenuItem {
    return {
      id: "image-cut",
      label: "Cut",
      icon: <CutIcon className="tiptap-button-icon" />,
      isVisible: (ctx) => !!getImageFigure(ctx),
      isEnabled: (ctx) => !!getImageElement(ctx),
      run: async (ctx) => {
        if (await copyImageToClipboard(ctx)) {
          deleteRightClickedImage(ctx);
        }
      },
    };
  },
  imageOpenInNewTab(): MenuItem {
    return {
      id: "image-open-new-tab",
      label: "Open in new tab",
      icon: <ExternalLinkIcon className="tiptap-button-icon" />,
      isVisible: (ctx) => !!getImageFigure(ctx),
      isEnabled: (ctx) => !!getImageAssetId(ctx) && !!ctx.openAssetInTab,
      run: (ctx) => {
        const assetId = getImageAssetId(ctx);
        if (assetId) ctx.openAssetInTab?.(assetId);
      },
    };
  },
  imageAlign(align: "left" | "center" | "right"): MenuItem {
    const icon =
      align === "left" ? <AlignLeftIcon className="tiptap-button-icon" /> :
        align === "center" ? <AlignCenterIcon className="tiptap-button-icon" /> :
          <AlignRightIcon className="tiptap-button-icon" />;
    return {
      id: `image-align-${align}`,
      label: align === "left" ? "Left" : align === "center" ? "Center" : "Right",
      icon,
      // Read the alignment straight off the clicked image's own DOM node,
      // same as the other image actions — not the PM-selection-resolved
      // node, which can drift when multiple images sit close together.
      isActive: (ctx) => !!getImageFigure(ctx)?.classList.contains(`asset-image-node--align-${align}`),
      run: ({ editor }) => { editor.chain().focus().updateAttributes("image", { align }).run(); },
    };
  },
  imageReplace(): MenuItem {
    return {
      id: "image-replace",
      label: "Replace image…",
      icon: <ImagePlusIcon className="tiptap-button-icon" />,
      run: async ({ editor: _editor }) => {
        // Your existing image upload flow here
        // e.g., open dialog -> get file -> upload -> replace selection attrs/src
      },
      isVisible: ({ editor }) => editor.isActive("image"),
    };
  },
  deleteNode(): MenuItem {
    return {
      id: "delete-node",
      label: "Delete",
      icon: <TrashIcon className="tiptap-button-icon" />,
      dangerous: true,
      run: ({ editor }) => editor.chain().focus().deleteSelection().run() as any,
      isEnabled: ({ editor }) => !editor.state.selection.empty,
    };
  },
  separator(): MenuItem {
    return {
      id: `sep-${Math.random().toString(36).slice(2)}`,
      noWrap: true,
      render: () => <Separator orientation="horizontal" decorative className="tt-separator" />,
    };
  }
};

function hasSelection(editor: any) {
  const sel = editor.state.selection;
  return !sel.empty; // true for TextSelection and NodeSelection
}

export const Download = {
  copyAsMarkdown(): MenuItem {
    return {
      id: "copy-as-markdown",
      label: "Copy as Markdown",
      icon: <CopyIcon className="tiptap-button-icon" />,
      run: async (ctx) => {
        try {
          await navigator.clipboard.writeText(getMarkdownContent(ctx.editor));
        } catch (e) {
          console.warn("Copy as Markdown failed:", e);
        }
      },
    };
  },
  markdown(): MenuItem {
    return {
      id: "download-markdown",
      label: "Markdown (.md)",
      icon: <RiMarkdownLine className="tiptap-button-icon" />,
      run: (ctx) => {
        const title = ctx.getActiveTitle?.() ?? "Untitled";
        downloadFile(`${title}.md`, getMarkdownContent(ctx.editor), "text/markdown");
      },
    };
  },
  json(): MenuItem {
    return {
      id: "download-json",
      label: "JSON (.json)",
      icon: <RiBracesLine className="tiptap-button-icon" />,
      run: (ctx) => {
        const title = ctx.getActiveTitle?.() ?? "Untitled";
        downloadFile(`${title}.json`, JSON.stringify(ctx.editor.getJSON(), null, 2), "application/json");
      },
    };
  },
  text(): MenuItem {
    return {
      id: "download-text",
      label: "Plain Text (.txt)",
      icon: <RiFileTextLine className="tiptap-button-icon" />,
      run: (ctx) => {
        const title = ctx.getActiveTitle?.() ?? "Untitled";
        downloadFile(`${title}.txt`, ctx.editor.getText(), "text/plain");
      },
    };
  },
};


export const Clipboard = {
  cut(): MenuItem {
    return {
      id: "cut",
      label: "Cut",
      shortcut: isMac() ? "⌘X" : "Ctrl+X",
      icon: <CutIcon className="tiptap-button-icon" />,
      isEnabled: ({ editor }) => hasSelection(editor),
      async run({ editor }) {
        const view = editor.view;
        // Let ProseMirror serialize to clipboard
        try {
          view.dom.focus();
          // @ts-ignore (execCommand is deprecated but widely supported)
          const ok = document.execCommand && document.execCommand("cut");
          if (ok) return;

          // Fallback: copy selected text then delete
          const { state, dispatch } = view;
          const { from, to } = state.selection;
          if (from !== to && navigator.clipboard?.writeText) {
            const text = state.doc.textBetween(from, to, "\n");
            await navigator.clipboard.writeText(text);
            dispatch(state.tr.deleteSelection());
          }
        } catch (e) {
          console.warn("Cut failed:", e);
        }
      },
      render: undefined,
    };
  },

  copy(): MenuItem {
    return {
      id: "copy",
      label: "Copy",
      shortcut: isMac() ? "⌘C" : "Ctrl+C",
      isEnabled: ({ editor }) => hasSelection(editor),
      icon: <CopyIcon className="tiptap-button-icon" />,
      async run({ editor }) {
        const view = editor.view;
        try {
          view.dom.focus();
          // @ts-ignore
          const ok = document.execCommand && document.execCommand("copy");
          if (ok) return;

          // Fallback: plain text copy
          const { state } = view;
          const { from, to } = state.selection;
          if (from !== to && navigator.clipboard?.writeText) {
            const text = state.doc.textBetween(from, to, "\n");
            await navigator.clipboard.writeText(text);
          }
        } catch (e) {
          console.warn("Copy failed:", e);
        }
      },
      render: undefined,
    };
  },

  paste(): MenuItem {
    return {
      id: "paste",
      label: "Paste",
      shortcut: isMac() ? "⌘V" : "Ctrl+V",
      icon: <PasteIcon className="tiptap-button-icon" />,
      // Only enable when we can read from clipboard (secure context + permission)
      isEnabled: () => !!navigator.clipboard?.read || !!navigator.clipboard?.readText,
      async run(ctx) {
        const { editor } = ctx;
        try {
          if (navigator.clipboard?.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageType = item.types.find((t) => t.startsWith("image/"));
              if (!imageType) continue;
              const blob = await item.getType(imageType);
              if (await insertImageFromClipboardBlob(ctx, blob)) return;
            }
          }

          const text = await navigator.clipboard.readText();
          if (!text) return;
          const { state, view } = editor;
          const { from, to } = state.selection;
          view.dispatch(state.tr.insertText(text, from, to));
          view.focus();
        } catch (e) {
          // If blocked, prompt user to use keyboard paste
          console.warn("Programmatic paste blocked. Use keyboard shortcut.", e);
          alert("Paste is blocked by the browser. Press " + (isMac() ? "⌘V" : "Ctrl+V") + " instead.");
        }
      },
    };
  },
};