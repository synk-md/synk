import * as Y from "yjs";
import { customAlphabet } from "nanoid";
import { IndexeddbPersistence } from "y-indexeddb";
import { getNoteLinkIndex, trackNoteLinks, deleteNoteLinkIndex } from "./note-link-index";
import { collectNoteLinks } from "./note-graph";
import {
  buildTreeFromFlat,
  diffFlatTrees,
  flattenTree,
  type FlatNodeRecord,
  type TreeNode,
} from "@/components/custom-ui/file-browser/tree";


const docs = new Map<string, { doc: Y.Doc, idb: IndexeddbPersistence }>()

// build a unique key so different notebooks/notes are isolated
const keyFor = (notebookId: string, noteId: string) => `nb:${notebookId}:n:${noteId}`;
const keyForSettings = (notebookId: string) => `nb:${notebookId}:settings`;
// Also doubles as the notebook index doc's WebRTC room name.
export const keyForIndex = (notebookId: string) => `nb:${notebookId}:index`;


const alphanumeric = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nanoid = customAlphabet(alphanumeric);
export const newNotebookId = () => nanoid(10);
export const newNoteId = () => nanoid(10);

// WebRTC signaling servers shared by every collaboration room (per-note and
// per-notebook-index). Set VITE_LOCAL_SIGNALING_URL in a .env.local file
// (e.g. VITE_LOCAL_SIGNALING_URL=ws://localhost:4444, run via `pnpm signaling`)
// to develop/test collaboration without depending on the public servers —
// it's tried first, with the public servers still there as a fallback.
const localSignalingUrl = import.meta.env.VITE_LOCAL_SIGNALING_URL as string | undefined
export const SIGNALING_SERVERS = [
  ...(localSignalingUrl ? [localSignalingUrl] : []),
  'wss://2310.td.org.uit.no:443/ws/',
]

// Creates or loads a Y.Doc for a specific note in a notebook.
export function getOrCreateYDoc(notebookId: string, noteId: string) {
  const key = keyFor(notebookId, noteId)
  let entry = docs.get(key)
  if (!entry) {
    const doc = new Y.Doc()
    const idb = new IndexeddbPersistence(key, doc)
    entry = { doc, idb }
    docs.set(key, entry)
    trackNoteLinks(notebookId, noteId, doc, idb.whenSynced)
  }
  return entry
}

const linkBackfills = new Map<string, Promise<void>>()

/** One-time backfill for legacy notes. Read one document at a time and release
 * temporary documents instead of populating the editor's long-lived cache. */
export async function ensureNoteLinks(notebookId: string, noteIds: string[], signal?: AbortSignal) {
  const previous = linkBackfills.get(notebookId) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const index = getNoteLinkIndex(notebookId)
    await index.idb.whenSynced
    const pending = new Map<string, string[]>()
    try {
      for (const noteId of noteIds) {
        if (signal?.aborted) return
        if (index.links.has(noteId) || pending.has(noteId)) continue
        const cached = docs.get(keyFor(notebookId, noteId))
        const doc = cached?.doc ?? new Y.Doc()
        const idb = cached?.idb ?? new IndexeddbPersistence(keyFor(notebookId, noteId), doc)
        try {
          await idb.whenSynced
          if (signal?.aborted) return
          if (!index.links.has(noteId)) pending.set(noteId, collectNoteLinks(doc))
        } finally {
          if (!cached) { await idb.destroy(); doc.destroy() }
        }
      }
    } finally {
      // Publish a backfill as one change, avoiding N graph rebuilds on startup.
      // Also preserve completed work if the graph closes during migration.
      index.doc.transact(() => {
        for (const [noteId, targets] of pending) {
          // A live editor's newer index entry always wins over a backfill.
          if (!index.links.has(noteId)) index.links.set(noteId, targets)
        }
      })
    }
  })
  linkBackfills.set(notebookId, task)
  try { await task } finally { if (linkBackfills.get(notebookId) === task) linkBackfills.delete(notebookId) }
}

// Deletes a single IndexedDB database by name, used for both per-note docs
// and the notebook-level settings/index docs.
async function deleteIndexedDbDatabase(dbName: string) {
  // Optional: Try opening it to ensure it exists and can be closed cleanly
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch (e) {
    // If open fails, maybe DB doesn't exist — that’s fine
    console.warn(`Database ${dbName} might not exist or couldn't be opened`, e);
  }

  // Delete the database
  return new Promise<void>((resolve, reject) => {
    const delReq = indexedDB.deleteDatabase(dbName);

    delReq.onsuccess = () => {
      resolve();
    };

    delReq.onerror = () => {
      console.error(`Error deleting IndexedDB database: ${dbName}`, delReq.error);
      reject(delReq.error);
    };

    delReq.onblocked = () => {
      console.warn(`Deletion of ${dbName} is blocked (maybe open in another tab)`);
    };
  });
}

// Deletes a note's Y.Doc from IndexedDB.
export async function deleteNoteFromIndexedDB(notebookId: string, noteId: string) {
  const index = getNoteLinkIndex(notebookId)
  await index.idb.whenSynced
  index.links.delete(noteId)
  return deleteIndexedDbDatabase(keyFor(notebookId, noteId));
}

// Deletes a notebook's own settings/index Y.Docs from IndexedDB (not its notes —
// call deleteNoteFromIndexedDB per note first).
export async function deleteNotebookMetaFromIndexedDB(notebookId: string) {
  await Promise.all([
    deleteNoteLinkIndex(notebookId),
    deleteIndexedDbDatabase(keyForSettings(notebookId)),
    deleteIndexedDbDatabase(keyForIndex(notebookId)),
  ]);
}


// Creates or loads a Y.Doc for the notebook's settings.
export function createNotebookSettingsDoc(notebookId: string) {
  const doc = new Y.Doc()
  const idb = new IndexeddbPersistence(keyForSettings(notebookId), doc)
  const settings = doc.getMap<any>("settings")
  return { doc, idb, settings }
}

const indexDocs = new Map<string, {
  doc: Y.Doc
  idb: IndexeddbPersistence
  nodes: Y.Map<FlatNodeRecord>
  meta: Y.Map<any>
}>()

// Creates or loads a Y.Doc for the notebook's index (e.g. file tree).
// `meta` carries the notebook's own link-sharing state (see notebook-meta.ts),
// living in the same doc as the tree so a single WebRTC room covers both.
// Cached per notebookId (like getOrCreateYDoc) so a write from one caller —
// e.g. the share dialog toggling link access — is immediately visible to any
// other caller already holding this doc, such as a live editor session's
// useNotebookFileSystem, without waiting for a remount or a round trip.
//
// `nodes` holds one entry per tree node (keyed by node id, see
// FlatNodeRecord) rather than the whole tree as a single value. That's what
// lets two peers' concurrent edits to *different* notes merge independently
// instead of one write replacing the other's entire tree - see
// readNotebookIndexTree/writeNotebookIndexTree below.
export function createNotebookIndexDoc(notebookId: string) {
  const key = keyForIndex(notebookId)
  let entry = indexDocs.get(key)
  if (!entry) {
    const doc = new Y.Doc()
    const idb = new IndexeddbPersistence(key, doc)
    const nodes = doc.getMap<FlatNodeRecord>('nodes')
    const meta = doc.getMap<any>('meta')
    entry = { doc, idb, nodes, meta }
    indexDocs.set(key, entry)
  }
  return entry
}

type NotebookIndexHandle = ReturnType<typeof createNotebookIndexDoc>

// Reads the notebook's file tree out of `nodes`. Call only after
// `idb.whenSynced` has resolved, so it reflects whatever was actually
// persisted for this browser.
export function readNotebookIndexTree(
  indexHandle: NotebookIndexHandle,
): { root: TreeNode | undefined; flat: Map<string, FlatNodeRecord> } {
  const flat = new Map<string, FlatNodeRecord>()
  indexHandle.nodes.forEach((record, id) => flat.set(id, record))
  return { root: buildTreeFromFlat(flat), flat }
}

// Persists `nextRoot` by diffing it against `prevFlat` (the flat snapshot
// last known to match `nodes`) and writing only the node(s) that actually
// changed, instead of replacing the whole tree. Returns the new flat
// snapshot to use as the base for the next diff.
export function writeNotebookIndexTree(
  indexHandle: NotebookIndexHandle,
  prevFlat: Map<string, FlatNodeRecord>,
  nextRoot: TreeNode,
  origin: unknown,
): { flat: Map<string, FlatNodeRecord> } {
  const { nodes, doc } = indexHandle
  const nextFlat = flattenTree(nextRoot)
  const { upserts, deletes } = diffFlatTrees(prevFlat, nextFlat)
  if (upserts.length || deletes.length) {
    doc.transact(() => {
      for (const [id, record] of upserts) nodes.set(id, record)
      for (const id of deletes) nodes.delete(id)
    }, origin)
  }
  return { flat: nextFlat }
}

// Evicts a notebook's cached index doc, e.g. when the notebook itself is
// deleted. Safe to call even if nothing is cached for this id.
export function evictNotebookIndexDoc(notebookId: string) {
  const key = keyForIndex(notebookId)
  const entry = indexDocs.get(key)
  if (!entry) return
  entry.doc.destroy()
  indexDocs.delete(key)
}
