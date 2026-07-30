import * as Y from "yjs";
import { customAlphabet } from "nanoid";
import { IndexeddbPersistence } from "y-indexeddb";

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
  }
  return entry
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
  return deleteIndexedDbDatabase(keyFor(notebookId, noteId));
}

// Deletes a notebook's own settings/index Y.Docs from IndexedDB (not its notes —
// call deleteNoteFromIndexedDB per note first).
export async function deleteNotebookMetaFromIndexedDB(notebookId: string) {
  await Promise.all([
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

const indexDocs = new Map<string, { doc: Y.Doc, idb: IndexeddbPersistence, tree: Y.Map<any>, meta: Y.Map<any> }>()

// Creates or loads a Y.Doc for the notebook's index (e.g. file tree).
// `meta` carries the notebook's own link-sharing state (see notebook-meta.ts),
// living in the same doc as the tree so a single WebRTC room covers both.
// Cached per notebookId (like getOrCreateYDoc) so a write from one caller —
// e.g. the share dialog toggling link access — is immediately visible to any
// other caller already holding this doc, such as a live editor session's
// useNotebookFileSystem, without waiting for a remount or a round trip.
export function createNotebookIndexDoc(notebookId: string) {
  const key = keyForIndex(notebookId)
  let entry = indexDocs.get(key)
  if (!entry) {
    const doc = new Y.Doc()
    const idb = new IndexeddbPersistence(key, doc)
    const tree = doc.getMap('tree')  // or getArray('root')
    const meta = doc.getMap<any>('meta')
    entry = { doc, idb, tree, meta }
    indexDocs.set(key, entry)
  }
  return entry
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