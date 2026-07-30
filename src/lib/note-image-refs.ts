import * as Y from "yjs"

// Must match extension-collaboration's default `field` option, which is
// what every note's Collaboration extension is configured with.
const COLLABORATION_FIELD = "default"

function collectAssetIds(fragment: Y.XmlFragment): Set<string> {
  const assetIds = new Set<string>()
  const walker = fragment.createTreeWalker(
    (node) => node instanceof Y.XmlElement && node.nodeName === "image"
  )

  for (const node of walker) {
    const assetId = (node as Y.XmlElement).getAttribute("assetId")
    if (typeof assetId === "string") assetIds.add(assetId)
  }

  return assetIds
}

/**
 * Tracks which image assetIds a note's Y.Doc embeds, so P2P asset requests
 * can be scoped to "is this actually part of the note" without re-walking
 * the whole document - text, marks, every node - on every single request.
 *
 * The asset-id set is rebuilt lazily: edits just mark the cache dirty via
 * `observeDeep`, and the (possibly large) tree walk only happens the next
 * time `has()` is actually called, not once per keystroke.
 */
export class NoteImageRefIndex {
  private readonly fragment: Y.XmlFragment
  private cache: Set<string> | null = null

  constructor(doc: Y.Doc, field: string = COLLABORATION_FIELD) {
    this.fragment = doc.getXmlFragment(field)
    this.fragment.observeDeep(this.invalidate)
  }

  has(assetId: string): boolean {
    if (!this.cache) {
      this.cache = collectAssetIds(this.fragment)
    }
    return this.cache.has(assetId)
  }

  destroy(): void {
    this.fragment.unobserveDeep(this.invalidate)
    this.cache = null
  }

  private readonly invalidate = () => {
    this.cache = null
  }
}
