import type * as Y from "yjs"
import type { LinkAccess } from "@/lib/note-meta"

export function getNotebookLinkAccess(meta: Y.Map<any>): LinkAccess {
  return meta.get("linkAccess") ?? "restricted"
}

export function setNotebookLinkAccess(meta: Y.Map<any>, access: LinkAccess) {
  meta.set("linkAccess", access)
}

export function getNotebookOwnerName(meta: Y.Map<any>): string | undefined {
  return meta.get("ownerName") ?? undefined
}

export function setNotebookOwnerName(meta: Y.Map<any>, name: string) {
  meta.set("ownerName", name)
}
