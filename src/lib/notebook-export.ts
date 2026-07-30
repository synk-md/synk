// Bundles an entire notebook into a single .zip: every note as markdown,
// every image asset as its original bytes, and a manifest.json carrying the
// raw tree (ids, folder structure, timestamps, link access) so a future
// "import notebook" feature can reconstruct the notebook exactly rather than
// having to re-infer structure from file paths.
import { strToU8, zipSync } from "fflate"

import type { Notebook, TreeNode } from "@/components/custom-ui/file-browser/tree"
import { exportNoteContent, fileExtensionForFormat, type NoteExportFormat } from "@/lib/note-export"
import { getImageAsset } from "@/lib/image-assets"

export const NOTEBOOK_EXPORT_VERSION = 1

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

function sanitizeSegment(name: string): string {
  return (name || "Untitled").replace(/[\\/:*?"<>|]/g, "_")
}

// Appends " (2)", " (3)", etc. so sibling files/folders with the same name
// (e.g. two notes both titled "Untitled") don't collide in the zip.
function uniqueName(used: Set<string>, base: string, ext?: string): string {
  const suffix = ext ? `.${ext}` : ""
  let candidate = `${base}${suffix}`
  let i = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${i})${suffix}`
    i += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

type ZipEntry = { path: string; data: Uint8Array }

async function collectEntries(
  node: TreeNode,
  notebookId: string,
  format: NoteExportFormat,
  dirPath: string,
  out: ZipEntry[],
  paths: Record<string, string>,
): Promise<void> {
  const usedNames = new Set<string>()
  const noteExt = fileExtensionForFormat(format)

  for (const child of node.children ?? []) {
    if (child.isFolder) {
      const dirName = uniqueName(usedNames, sanitizeSegment(child.name))
      await collectEntries(child, notebookId, format, `${dirPath}${dirName}/`, out, paths)
      continue
    }

    if (typeof child.id !== "string") continue

    if (child.assetId) {
      const asset = await getImageAsset(child.assetId)
      if (!asset) continue
      const ext = MIME_EXTENSIONS[asset.mimeType] ?? "bin"
      const base = sanitizeSegment(child.name || "Image").replace(/\.[a-z0-9]{2,5}$/i, "")
      const fileName = uniqueName(usedNames, base, ext)
      const path = `${dirPath}${fileName}`
      out.push({ path, data: new Uint8Array(await asset.blob.arrayBuffer()) })
      paths[child.id] = path
      continue
    }

    const fileName = uniqueName(usedNames, sanitizeSegment(child.name), noteExt)
    const path = `${dirPath}${fileName}`
    const content = await exportNoteContent(notebookId, child.id, format)
    out.push({ path, data: strToU8(content) })
    paths[child.id] = path
  }
}

// Produces the raw bytes of a .zip archive for the given notebook, with every
// note rendered in the requested format (image assets are always copied as-is).
export async function exportNotebookArchive(
  notebook: Notebook,
  format: NoteExportFormat = "markdown",
): Promise<Uint8Array> {
  const entries: ZipEntry[] = []
  const paths: Record<string, string> = {}
  await collectEntries(notebook.root, notebook.id, format, "", entries, paths)

  const manifest = {
    version: NOTEBOOK_EXPORT_VERSION,
    exportedAt: Date.now(),
    notebook: { id: notebook.id, name: notebook.name, createdAt: notebook.createdAt },
    tree: notebook.root,
    // Maps each note/image node's id to its path in this archive, so
    // importNotebookArchive can rebuild the tree without re-deriving the
    // sanitize/dedup filename logic above.
    paths,
  }
  entries.push({ path: "manifest.json", data: strToU8(JSON.stringify(manifest, null, 2)) })

  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.path] = entry.data

  return zipSync(files, { level: 6 })
}
