// Headless rendering of a note's Y.Doc content for export, independent of
// whether the note is currently open in the live editor. Mirrors the
// extension set in simple-editor.tsx closely enough to parse the same
// schema (node/mark types), but skips anything UI-only (collaboration
// carets, upload handlers, table of contents) since nothing here is ever
// attached to the DOM.
import { Editor } from "@tiptap/core"
import { StarterKit } from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Highlight } from "@tiptap/extension-highlight"
import { Typography } from "@tiptap/extension-typography"
import { Subscript } from "@tiptap/extension-subscript"
import { Superscript } from "@tiptap/extension-superscript"
import Collaboration from "@tiptap/extension-collaboration"
import * as Y from "yjs"

import { AssetImage } from "@/components/tiptap-node/image-node/image-node-extension"
import { HorizontalRule } from "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension"
import { NoteLink } from "@/components/tiptap-node/note-link-node/note-link-node-extension"
import { getMarkdownContent } from "@/extensions/markdown-conversion"
import { getOrCreateYDoc } from "@/lib/yjs-utils"

export type NoteExportFormat = "markdown" | "json" | "text"

const FORMAT_EXTENSIONS: Record<NoteExportFormat, { ext: string; mimeType: string }> = {
  markdown: { ext: "md", mimeType: "text/markdown" },
  json: { ext: "json", mimeType: "application/json" },
  text: { ext: "txt", mimeType: "text/plain" },
}

export function fileExtensionForFormat(format: NoteExportFormat) {
  return FORMAT_EXTENSIONS[format].ext
}

export function mimeTypeForFormat(format: NoteExportFormat) {
  return FORMAT_EXTENSIONS[format].mimeType
}

async function renderNoteContent(doc: Y.Doc, format: NoteExportFormat): Promise<string> {
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
      Typography,
      Superscript,
      Subscript,
      Collaboration.configure({ document: doc as unknown as any }),
    ],
  })

  try {
    if (format === "markdown") return getMarkdownContent(editor)
    if (format === "json") return JSON.stringify(editor.getJSON(), null, 2)
    return editor.getText()
  } finally {
    editor.destroy()
  }
}

// Loads a note's Y.Doc (from IndexedDB if it isn't already in memory) and
// serializes its content to the requested format, without requiring the
// note to be open in the live editor.
export async function exportNoteContent(notebookId: string, noteId: string, format: NoteExportFormat): Promise<string> {
  const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
  await idb.whenSynced
  return renderNoteContent(doc, format)
}
