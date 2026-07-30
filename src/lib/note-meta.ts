import type * as Y from "yjs"

export type NoteMeta = {
  title?: string
  tags?: string[]
  archived?: boolean
  createdAt?: number
  seeded?: boolean
  ownerName?: string
}

export type LinkAccess = "restricted" | "view" | "edit"

export function readNoteMeta(meta: Y.Map<any>): NoteMeta {
  return {
    title: meta.get("title") ?? "",
    tags: meta.get("tags") ?? [],
    archived: meta.get("archived") ?? false,
    createdAt: meta.get("createdAt") ?? Date.now(),
    seeded: meta.get("seeded") ?? false,
  }
}

export function setNoteCreatedAt(meta: Y.Map<any>) {
  meta.set("createdAt", Date.now())
}

export function setNoteTitle(meta: Y.Map<any>, title: string) {
  meta.set("title", title)
}

export function setNoteTags(meta: Y.Map<any>, tags: string[]) {
  meta.set("tags", tags)
}

export function markArchived(meta: Y.Map<any>, archived: boolean) {
  meta.set("archived", archived)
}

export function setSeeded(meta: Y.Map<any>, seeded: boolean) {
  meta.set("seeded", seeded)
}

export function getNoteLinkAccess(meta: Y.Map<any>): LinkAccess {
  return meta.get("linkAccess") ?? "restricted"
}

export function setNoteLinkAccess(meta: Y.Map<any>, access: LinkAccess) {
  meta.set("linkAccess", access)
}

// Whether this note's linkAccess should keep following its notebook's own
// linkAccess (true — the default for a note nobody has deliberately shared
// on its own), or was pinned by someone explicitly changing this note's own
// share settings (false — a manual override, left alone by the
// notebook-level auto-sync).
//
// If never explicitly tagged, only treat it as inherited when linkAccess
// itself was also never set — i.e. a genuinely untouched note. A note whose
// linkAccess is already set predates this tracking (from the older
// per-note-only sharing flow) and must default to "manual", or the
// notebook-level sync would silently downgrade an existing single-note
// share the moment it (or its notebook) is next opened.
export function isNoteLinkAccessInherited(meta: Y.Map<any>): boolean {
  if (meta.has("linkAccessInherited")) return meta.get("linkAccessInherited")
  return !meta.has("linkAccess")
}

export function setNoteLinkAccessInherited(meta: Y.Map<any>, inherited: boolean) {
  meta.set("linkAccessInherited", inherited)
}

export function getNoteOwnerName(meta: Y.Map<any>): string | undefined {
  return meta.get("ownerName") ?? undefined
}

export function setNoteOwnerName(meta: Y.Map<any>, name: string) {
  meta.set("ownerName", name)
}

