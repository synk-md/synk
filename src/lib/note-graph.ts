import * as Y from "yjs"

export type NoteEdge = { source: string; target: string }

export function collectNoteLinks(doc: Y.Doc): string[] {
  const ids = new Set<string>()
  for (const node of doc.getXmlFragment("default").createTreeWalker(
    node => node instanceof Y.XmlElement && node.nodeName === "noteLink",
  )) {
    const id = (node as Y.XmlElement).getAttribute("noteId")
    if (typeof id === "string" && id) ids.add(id)
  }
  return [...ids].sort()
}

// A connection is drawn once, even when two notes link to each other.
export function buildNoteEdges(ids: string[], links: Record<string, string[]>): NoteEdge[] {
  const available = new Set(ids)
  const edges = new Map<string, NoteEdge>()
  for (const source of ids) {
    for (const target of links[source] ?? []) {
      if (target === source || !available.has(target)) continue
      const pair = [source, target].sort()
      edges.set(JSON.stringify(pair), { source: pair[0], target: pair[1] })
    }
  }
  return [...edges.values()]
}
