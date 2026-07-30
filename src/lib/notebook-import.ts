// Reverses notebook-export.ts: rebuilds a notebook's tree, per-note Y.Doc
// content, and image assets from the bytes of a .zip it produced. Uses the
// manifest's `paths` map (node id -> zip path) instead of re-deriving
// filenames, since the export's sanitize/dedup naming only needs to be
// correct in one direction.
import { strFromU8, unzipSync } from "fflate"

import type { TreeNode } from "@/components/custom-ui/file-browser/tree"
import { extensionOf, importNoteContent } from "@/lib/note-import"
import { storeImageAsset } from "@/lib/image-assets"
import { NOTEBOOK_EXPORT_VERSION } from "@/lib/notebook-export"

type Manifest = {
  version: number
  notebook: { id: string; name: string; createdAt: number }
  tree: TreeNode
  paths?: Record<string, string>
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

// Stores an image's bytes under their content hash and returns the (likely
// identical) asset id, since the asset store keys by content hash.
async function writeImageAsset(path: string, bytes: Uint8Array): Promise<string> {
  const mimeType = EXTENSION_MIME_TYPES[extensionOf(path)] ?? "application/octet-stream"
  const { assetId } = await storeImageAsset(new Blob([bytes], { type: mimeType }))
  return assetId
}

async function populateTree(
  notebookId: string,
  node: TreeNode,
  paths: Record<string, string>,
  files: Record<string, Uint8Array>,
) {
  for (const child of node.children ?? []) {
    if (child.isFolder) {
      await populateTree(notebookId, child, paths, files)
      continue
    }

    const path = typeof child.id === "string" ? paths[child.id] : undefined
    const bytes = path ? files[path] : undefined
    if (!path || !bytes) continue

    if (child.assetId) {
      child.assetId = await writeImageAsset(path, bytes)
    } else {
      await importNoteContent(notebookId, child.id as string, path, strFromU8(bytes), {
        title: child.name,
        createdAt: child.createdAt,
      })
    }
  }
}

export type ImportedNotebook = { name: string; root: TreeNode }

// Rebuilds a notebook's tree, note content (in fresh Y.Docs keyed by
// `notebookId`), and image assets from the bytes of a .zip produced by
// exportNotebookArchive.
export async function importNotebookArchive(
  archiveBytes: Uint8Array,
  notebookId: string,
): Promise<ImportedNotebook> {
  const files = unzipSync(archiveBytes)
  const manifestBytes = files["manifest.json"]
  if (!manifestBytes) throw new Error("This file isn't a notebook export (missing manifest.json).")

  let manifest: Manifest
  try {
    manifest = JSON.parse(strFromU8(manifestBytes))
  } catch {
    throw new Error("This file isn't a valid notebook export (manifest.json is corrupt).")
  }

  if (manifest.version !== NOTEBOOK_EXPORT_VERSION) {
    throw new Error(`Unsupported notebook export version: ${manifest.version}`)
  }
  if (!manifest.tree) {
    throw new Error("This file isn't a valid notebook export (missing tree).")
  }

  const root: TreeNode = JSON.parse(JSON.stringify(manifest.tree))
  root.id = `root_${notebookId}`

  await populateTree(notebookId, root, manifest.paths ?? {}, files)

  return { name: manifest.notebook?.name || "Imported notebook", root }
}
