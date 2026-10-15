/**
 * Putting back signed records that someone else deleted or replaced.
 *
 * A record cannot be forged, but anyone who can write to the document can
 * remove one, and whoever never saw it would then never know it existed. A
 * device that did see it puts it back. Re-adding is safe because it is signed:
 * what comes back is exactly what was there.
 *
 * Only someone else's change is undone, never this device's own. Nothing is
 * put back when what replaced it is the same record, which is also what stops
 * two devices restoring at once from going back and forth.
 */

import * as Y from "yjs"

/** A signed record, or a capability token, which carries its signature inside. */
function isSigned(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0
  return typeof value === "object" && value !== null && typeof (value as { sig?: unknown }).sig === "string"
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function guardRecords(doc: Y.Doc, guarded: (name: string) => boolean): () => void {
  const watched = new Map<string, () => void>()
  let pending: [Y.Map<unknown>, string, unknown][] = []

  const restore = () => {
    const due = pending
    pending = []
    doc.transact(() => {
      for (const [map, key, value] of due) {
        if (!same(map.get(key), value)) map.set(key, value)
      }
    })
  }

  const watch = () => {
    for (const name of [...doc.share.keys()]) {
      if (watched.has(name) || !guarded(name)) continue
      const map = doc.getMap<unknown>(name)
      const observer = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
        if (transaction.local) return
        for (const [key, change] of event.changes.keys) {
          if (change.action === "add" || !isSigned(change.oldValue)) continue
          if (same(map.get(key), change.oldValue)) continue
          if (pending.length === 0) setTimeout(restore, 0)
          pending.push([map, key, change.oldValue])
        }
      }
      map.observe(observer)
      watched.set(name, () => {
        map.unobserve(observer)
      })
    }
  }

  doc.on("afterTransaction", watch)
  watch()
  return () => {
    doc.off("afterTransaction", watch)
    for (const stop of watched.values()) stop()
    watched.clear()
  }
}
