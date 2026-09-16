import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"

type Container = Y.XmlFragment | Y.XmlElement

/** Maintains link counts from changed XML subtrees, ignoring text/format edits. */
export class NoteLinkTracker {
  private children = new Map<Container, Set<Container>>()
  private targets = new Map<Y.XmlElement, string>()
  private counts = new Map<string, number>()
  private fragment: Y.XmlFragment
  private publish: (targets: string[]) => void
  private last = ""

  constructor(doc: Y.Doc, publish: (targets: string[]) => void) {
    this.fragment = doc.getXmlFragment("default")
    this.publish = publish
    this.add(this.fragment)
    this.flush()
    this.fragment.observeDeep(this.update)
  }

  private target(node: Container) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== "noteLink") return
    const previous = this.targets.get(node)
    const value = node.getAttribute("noteId")
    const next = typeof value === "string" && value ? value : undefined
    if (previous === next) return
    if (previous) {
      const count = this.counts.get(previous)! - 1
      if (count) this.counts.set(previous, count)
      else this.counts.delete(previous)
      this.targets.delete(node)
    }
    if (next) {
      this.targets.set(node, next)
      this.counts.set(next, (this.counts.get(next) ?? 0) + 1)
    }
  }

  private add(node: Container) {
    if (this.children.has(node)) return
    const children = new Set(node.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement))
    this.children.set(node, children)
    this.target(node)
    children.forEach(child => this.add(child))
  }

  private remove(node: Container) {
    this.children.get(node)?.forEach(child => this.remove(child))
    this.children.delete(node)
    if (node instanceof Y.XmlElement) {
      const target = this.targets.get(node)
      if (target) {
        const count = this.counts.get(target)! - 1
        if (count) this.counts.set(target, count)
        else this.counts.delete(target)
        this.targets.delete(node)
      }
    }
  }

  private update = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    let changed = false
    for (const event of events) {
      if (!(event instanceof Y.YXmlEvent)) continue
      const node = event.target
      if (!(node instanceof Y.XmlFragment) || !this.children.has(node)) continue
      if (event.attributesChanged.has("noteId")) { this.target(node); changed = true }
      if (event.changes.added.size || event.changes.deleted.size) {
        const previous = this.children.get(node)!
        const next = new Set(node.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement))
        for (const child of previous) if (!next.has(child as Y.XmlElement)) this.remove(child)
        for (const child of next) if (!previous.has(child)) this.add(child)
        this.children.set(node, next)
        changed = true
      }
    }
    if (changed) this.flush()
  }

  private flush() {
    const targets = [...this.counts.keys()].sort()
    const serialized = JSON.stringify(targets)
    if (serialized === this.last) return
    this.last = serialized
    this.publish(targets)
  }

  destroy() {
    this.fragment.unobserveDeep(this.update)
    this.children.clear()
    this.targets.clear()
    this.counts.clear()
  }
}

const indexes = new Map<string, ReturnType<typeof createIndex>>()
function createIndex(notebookId: string) {
  // Local derived data, deliberately separate from the shared notebook index:
  // a peer with incomplete note content must not overwrite another peer's links.
  const doc = new Y.Doc()
  const idb = new IndexeddbPersistence(`nb:${notebookId}:links-v1`, doc)
  return { doc, idb, links: doc.getMap<string[]>("links") }
}

export function getNoteLinkIndex(notebookId: string) {
  let index = indexes.get(notebookId)
  if (!index) { index = createIndex(notebookId); indexes.set(notebookId, index) }
  return index
}

export function trackNoteLinks(notebookId: string, noteId: string, doc: Y.Doc, ready: Promise<unknown>) {
  const index = getNoteLinkIndex(notebookId)
  let disposed = false
  let tracker: NoteLinkTracker | undefined
  const destroy = () => { disposed = true; tracker?.destroy() }
  doc.on("destroy", destroy)
  void Promise.all([ready, index.idb.whenSynced]).then(() => {
    if (disposed) return
    tracker = new NoteLinkTracker(doc, targets => {
      if (JSON.stringify(index.links.get(noteId)) !== JSON.stringify(targets)) index.links.set(noteId, targets)
    })
  }).catch(error => console.error("Could not index note links", error))
}

export async function deleteNoteLinkIndex(notebookId: string) {
  const index = getNoteLinkIndex(notebookId)
  await index.idb.clearData()
  index.doc.destroy()
  indexes.delete(notebookId)
}
