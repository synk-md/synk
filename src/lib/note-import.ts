// Parses a single note's content (markdown/json/plain text, detected from
// the source filename's extension) into a Y.Doc. Shared by the
// notebook-archive importer (notebook-import.ts) and the file explorer's
// per-note "Import" toolbar button.
import { Editor } from "@tiptap/core"
import { StarterKit } from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Highlight } from "@tiptap/extension-highlight"
import { Typography } from "@tiptap/extension-typography"
import { Subscript } from "@tiptap/extension-subscript"
import { Superscript } from "@tiptap/extension-superscript"
import Collaboration from "@tiptap/extension-collaboration"

import { AssetImage } from "@/components/tiptap-node/image-node/image-node-extension"
import { HorizontalRule } from "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension"
import { NoteLink } from "@/components/tiptap-node/note-link-node/note-link-node-extension"
import { Table } from "@/components/tiptap-node/table-node/table-node-extension"
import { markdownToProseMirrorDoc } from "@/extensions/markdown-conversion/markdown-conversion"
import { getOrCreateYDoc } from "@/lib/yjs-utils"

export function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename)
  return match ? match[1].toLowerCase() : ""
}

export function isImportableNoteFile(file: File) {
  const ext = extensionOf(file.name)
  return ext === "md"
    || ext === "markdown"
    || ext === "txt"
    || ext === "json"
    || file.type === "text/markdown"
    || file.type === "text/plain"
    || file.type === "application/json"
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
}

export function imageMimeType(file: File): string | undefined {
  return file.type.startsWith("image/") ? file.type : IMAGE_MIME_TYPES[extensionOf(file.name)]
}

export function isImportableFolderFile(file: File) {
  return extensionOf(file.name) === "md" || Boolean(imageMimeType(file))
}

export function plainTextToDoc(raw: string) {
  const lines = raw.length ? raw.split("\n") : [""]
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  }
}

export type NoteContentMeta = { title?: string; createdAt?: number }

export type NoteImportItem = {
  file: File
  path?: string
}

// Writes `raw` into the note's Y.Doc through a headless Tiptap editor bound
// to it via Collaboration — the same path the live editor reads from.
export async function importNoteContent(
  notebookId: string,
  noteId: string,
  filename: string,
  raw: string,
  meta?: NoteContentMeta,
) {
  const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
  await idb.whenSynced
  const metaMap = doc.getMap<any>("meta")

  const editor = new Editor({
    editable: false,
    extensions: [
      StarterKit.configure({ horizontalRule: false, undoRedo: false }),
      HorizontalRule,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: true }),
      AssetImage,
      NoteLink,
      Table,
      Typography,
      Superscript,
      Subscript,
      Collaboration.configure({ document: doc as unknown as any }),
    ],
  })

  try {
    const ext = extensionOf(filename)
    if (ext === "json") editor.commands.setContent(JSON.parse(raw))
    // Parsed directly (rather than via the `fromMarkdown` command, which
    // internally calls `editor.commands.setContent` a second time) — that
    // nested command-proxy call mismatches transactions against the
    // Collaboration extension's Y.Doc-backed state.
    else if (ext === "md" || ext === "markdown") {
      editor.commands.setContent(markdownToProseMirrorDoc(editor, raw).toJSON())
    } else {
      editor.commands.setContent(plainTextToDoc(raw))
    }

    // Give y-indexeddb a moment to persist the update (mirrors seed-welcome-note.ts).
    await new Promise(requestAnimationFrame)
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      await idb.whenSynced
    } catch {}

    metaMap.doc?.transact(() => {
      if (meta?.title) metaMap.set("title", meta.title)
      metaMap.set("createdAt", meta?.createdAt ?? Date.now())
    })
  } finally {
    editor.destroy()
  }
}
