import * as React from "react"
import { WebrtcProvider } from "y-webrtc"
import * as Y from "yjs"

import type { FlatNodeRecord, Notebook, TreeNode } from "./tree"
import { useFileSystem } from "./use-file-system"
import {
  createNotebookIndexDoc,
  keyForDirectory,
  keyForIndex,
  readNotebookIndexTree,
  writeNotebookIndexTree,
  SIGNALING_SERVERS,
} from "@/lib/yjs-utils"
import type { LinkAccess } from "@/lib/note-meta"
import { getNotebookLinkAccess, setNotebookLinkAccess } from "@/lib/notebook-meta"
import { useNotebookReplication } from "@/hooks/use-notebook-replication"
import { hasAdmittedMembers, hasOutstandingInvitations } from "@/lib/workspace"

/** How long to stay in the index room after the last invitation is settled. */
const JOIN_LINGER_MS = 30_000

// Optional here (rather than required) since some callers use a plain
// useFileSystem() fallback stub (e.g. a single-note share's synthetic root)
// that has no real notebook to carry a notebook-level link access at all.
export type NotebookFileSystemApi = ReturnType<typeof useFileSystem> & {
  linkAccess?: LinkAccess
  setLinkAccess?: (access: LinkAccess) => void
  treeReady?: boolean
  indexProvider?: WebrtcProvider | null
  /** Somebody other than the founder has been admitted. */
  sharedWithMembers?: boolean
}

// How long a share page waits for a peer to deliver the real tree before
// treating "nothing in my own IndexedDB" as authoritative. Guards against a
// guest's very first local edit (made before the real tree has arrived)
// being persisted as if an empty notebook were the true state, which would
// otherwise briefly present (and risk building on top of) an empty tree
// instead of the owner's real one.
const TREE_SYNC_GRACE_MS = 5000

// Tags every Yjs transaction this hook writes to a notebook's tree doc
// itself, so the tree observer below can recognize (and ignore) the echo of
// its own write instead of re-processing it as an external/peer change.
const LOCAL_WRITE_ORIGIN = Symbol("useNotebookFileSystem:local-write")

export type UseNotebookFileSystemOptions = {
  /**
   * Seeds link access optimistically before the real value is known, so a
   * fresh guest on a shared-notebook page still connects over WebRTC instead
   * of being stuck at the safe "restricted" default (which never connects).
   * Once the real value is observed (from IndexedDB or a peer) it overrides
   * this. Local/owner editing should leave this unset — "restricted" is the
   * correct default there, since the notebook's own persisted value loads
   * almost immediately from the owner's own IndexedDB.
   */
  optimisticLinkAccess?: LinkAccess
  /**
   * Whether to seed the shared doc with `notebook.root` the moment nothing
   * is found in this browser's own IndexedDB. Correct for the local owner
   * editor — a brand new notebook has no peer to race. Wrong for a share
   * page: its "root" is a synthetic empty/single-note stub, and seeding it
   * immediately can win a race against the owner's real tree still arriving
   * over WebRTC and wipe it. Share pages should pass `false` and instead
   * wait for `treeReady` (see return value) before allowing any tree edits.
   * @default true
   */
  seedIfEmpty?: boolean
  /**
   * Sync the directory and tree through the relay, when one is configured.
   * Only for a notebook that is this device's own; a link guest's page must
   * not start publishing a directory it merely looked at.
   * @default false
   */
  replicate?: boolean
}

export function useNotebookFileSystem(
  notebook: Notebook | null,
  updateNotebookRoot: (id: string, root: TreeNode) => void,
  options: UseNotebookFileSystemOptions = {},
) {
  const { optimisticLinkAccess = "restricted", seedIfEmpty = true, replicate = false } = options
  const activeNotebookId = notebook?.id ?? null
  const initialNotebookRoot = React.useMemo(() => notebook?.root, [activeNotebookId])
  type NotebookIndexHandle = ReturnType<typeof createNotebookIndexDoc>
  const indexDocRef = React.useRef<NotebookIndexHandle | null>(null)
  const providerRef = React.useRef<WebrtcProvider | null>(null)
  const [linkAccess, setLinkAccessState] = React.useState<LinkAccess>(optimisticLinkAccess)
  const [indexProvider, setIndexProvider] = React.useState<WebrtcProvider | null>(null)
  // Someone has been invited and has not been let in yet. The redemption and
  // the grant both travel through the index room, so it has to be joined for
  // that whole window regardless of whether the notebook is link-shared.
  const [awaitingJoiners, setAwaitingJoiners] = React.useState(false)
  // Membership, as opposed to link sharing. A private notebook with members
  // still has to sync to them, so this gates the transport too.
  const [sharedWithMembers, setSharedWithMembers] = React.useState(false)
  // True once it's safe to persist local tree edits: either the real tree
  // has been observed (from this browser's IndexedDB or a peer), or — only
  // when seedIfEmpty is false — the grace window closed with nothing found.
  // Mirrored into a ref so handleRootChange always reads the current value
  // without needing to be recreated (and re-subscribed) on every flip.
  const [treeReady, setTreeReadyState] = React.useState(seedIfEmpty)
  const treeReadyRef = React.useRef(seedIfEmpty)
  const setTreeReady = React.useCallback((ready: boolean) => {
    treeReadyRef.current = ready
    setTreeReadyState(ready)
  }, [])

  // The flat (id -> node record) snapshot last known to match what's
  // persisted in `indexHandle.nodes`, i.e. the base the next local edit is
  // diffed against. Diffing against the true persisted state (rather than,
  // say, the previous in-memory tree) is what keeps a local edit from
  // rewriting nodes a peer changed concurrently — only the node(s) this
  // edit actually touched get written.
  const lastFlatRef = React.useRef<Map<string, FlatNodeRecord>>(new Map())

  const handleRootChange = React.useCallback(
    (nextRoot: TreeNode) => {
      if (!activeNotebookId) return
      // Defense in depth: callers should already gate creation/rename/
      // delete/move on `treeReady` (see UseNotebookFileSystemOptions.seedIfEmpty),
      // but refusing the write here too means a local edit can never race
      // the real tree still arriving over WebRTC and clobber it.
      if (!treeReadyRef.current) return

      updateNotebookRoot(activeNotebookId, nextRoot)
      const indexHandle = indexDocRef.current
      if (indexHandle) {
        const { flat } = writeNotebookIndexTree(
          indexHandle,
          lastFlatRef.current,
          nextRoot,
          LOCAL_WRITE_ORIGIN,
        )
        lastFlatRef.current = flat
      }
    },
    [activeNotebookId, updateNotebookRoot],
  )

  const fs = useFileSystem({ root: notebook?.root, onRootChange: handleRootChange })
  const { setRoot } = fs

  React.useEffect(() => {
    if (!activeNotebookId) return

    const indexHandle = createNotebookIndexDoc(activeNotebookId)
    indexDocRef.current = indexHandle
    lastFlatRef.current = new Map()
    let disposed = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    setLinkAccessState(optimisticLinkAccess)
    setTreeReady(seedIfEmpty)

    const applyRootFromDoc = (root: TreeNode | undefined, flat: Map<string, FlatNodeRecord>) => {
      if (!root) return
      lastFlatRef.current = flat
      setRoot(root)
      updateNotebookRoot(activeNotebookId, root)
      clearTimeout(graceTimer)
      setTreeReady(true)
    }

    const observer = (_event: unknown, transaction: { origin: unknown }) => {
      if (disposed) return
      // Ignore the echo of this hook's own write (see handleRootChange) -
      // it's already reflected in local state from the edit that caused it,
      // so re-applying it here is at best redundant and at worst a race.
      if (transaction.origin === LOCAL_WRITE_ORIGIN) return
      const { root, flat } = readNotebookIndexTree(indexHandle)
      applyRootFromDoc(root, flat)
    }

    indexHandle.nodes.observe(observer)

    // Only adopt a read once the key has actually been set (by this browser's
    // own IndexedDB history or a peer) — an unset key just means "not known
    // yet", not "restricted", so it must not stomp the optimistic seed above
    // before a guest has had a chance to connect and learn the real value.
    const applyMetaFromDoc = () => {
      if (disposed) return
      if (!indexHandle.meta.has("linkAccess")) return
      setLinkAccessState(getNotebookLinkAccess(indexHandle.meta))
    }

    indexHandle.meta.observe(applyMetaFromDoc)
    applyMetaFromDoc()

    ;(async () => {
      try {
        await indexHandle.idb.whenSynced
      } catch {}
      if (disposed) return
      const { root: stored, flat } = readNotebookIndexTree(indexHandle)
      if (stored) {
        applyRootFromDoc(stored, flat)
      } else if (seedIfEmpty) {
        if (initialNotebookRoot) {
          const { flat: seededFlat } = writeNotebookIndexTree(
            indexHandle,
            new Map(),
            initialNotebookRoot,
            LOCAL_WRITE_ORIGIN,
          )
          lastFlatRef.current = seededFlat
        }
        setTreeReady(true)
      } else {
        // Nothing in this browser's own IndexedDB, and we're not allowed to
        // assume that means "genuinely empty" (see seedIfEmpty doc) — give a
        // peer a window to deliver the real tree before treating it as such.
        graceTimer = setTimeout(() => {
          if (!disposed) setTreeReady(true)
        }, TREE_SYNC_GRACE_MS)
      }
      applyMetaFromDoc()
    })()

    return () => {
      disposed = true
      clearTimeout(graceTimer)
      indexHandle.nodes.unobserve(observer)
      indexHandle.meta.unobserve(applyMetaFromDoc)
      // Not destroyed: createNotebookIndexDoc caches this doc per notebookId
      // so other holders (e.g. the share dialog) keep working after unmount.
      indexDocRef.current = null
    }
  }, [activeNotebookId, initialNotebookRoot, optimisticLinkAccess, seedIfEmpty, setRoot, setTreeReady, updateNotebookRoot])

  // Connects a WebRTC provider for the notebook's tree/meta doc whenever it's
  // actually shared, mirroring the per-note collaboration gating in
  // simple-editor.tsx (room `nb:{id}:index`, same signaling servers).
  // Watched separately from link access, which is a different question about a
  // different thing and was previously the only reason to join the room.
  React.useEffect(() => {
    const indexHandle = indexDocRef.current
    if (!activeNotebookId || !indexHandle) {
      setAwaitingJoiners(false)
      setSharedWithMembers(false)
      return
    }
    const doc = indexHandle.doc
    let linger: ReturnType<typeof setTimeout> | undefined

    const recompute = () => {
      setSharedWithMembers(hasAdmittedMembers(doc))
      if (hasOutstandingInvitations(doc)) {
        clearTimeout(linger)
        linger = undefined
        setAwaitingJoiners(true)
        return
      }
      // Granting membership is the act that clears the last outstanding
      // invitation, and the grant still has to reach the person it admitted.
      // Dropping the connection in the same tick would strand it.
      if (linger) return
      linger = setTimeout(() => {
        linger = undefined
        setAwaitingJoiners(false)
      }, JOIN_LINGER_MS)
    }

    recompute()
    doc.on("update", recompute)
    return () => {
      clearTimeout(linger)
      doc.off("update", recompute)
    }
  }, [activeNotebookId, treeReady])

  const replication = useNotebookReplication(replicate ? activeNotebookId : null, {
    tree: sharedWithMembers,
  })
  const linkShared = linkAccess !== "restricted"
  // With a relay, the directory and the members' tree go through it, and the
  // WebRTC room carries the tree only for link guests - who can read it by
  // definition - or else just presence. Without one, the rooms carry both, as
  // they always did.
  const treeRoom: "content" | "presence" | "none" = replication.relay
    ? linkShared
      ? "content"
      : sharedWithMembers
        ? "presence"
        : "none"
    : linkShared || awaitingJoiners || sharedWithMembers
      ? "content"
      : "none"
  const directoryRoom = !replication.relay && treeRoom === "content"

  React.useEffect(() => {
    const indexHandle = indexDocRef.current
    if (!activeNotebookId || !indexHandle) return

    if (treeRoom === "none") {
      providerRef.current?.disconnect()
      providerRef.current?.destroy()
      providerRef.current = null
      return
    }

    if (providerRef.current) return

    // The tree keeps the room it always had, which is where link guests look.
    // Presence gets its own, with an empty document, so text never enters it.
    const room = `${keyForIndex(activeNotebookId)}${treeRoom === "presence" ? ":presence" : ""}`
    const provider = new WebrtcProvider(room, treeRoom === "presence" ? new Y.Doc() : indexHandle.tree, {
      signaling: SIGNALING_SERVERS,
      password: room,
    })
    const directoryName = keyForDirectory(activeNotebookId)
    const directory = directoryRoom
      ? new WebrtcProvider(directoryName, indexHandle.doc, {
          signaling: SIGNALING_SERVERS,
          password: directoryName,
        })
      : null
    providerRef.current = provider
    setIndexProvider(provider)

    return () => {
      provider.disconnect()
      provider.destroy()
      directory?.disconnect()
      directory?.destroy()
      if (providerRef.current === provider) providerRef.current = null
      setIndexProvider(null)
    }
    // Re-runs when the doc identity or notebook changes, or once linkAccess
    // flips away from "restricted" — indexDocRef.current itself isn't a dep
    // since refs aren't reactive, but it's set synchronously in the effect
    // above, which always runs before this one on the same commit.
  }, [activeNotebookId, treeRoom, directoryRoom])

  const setLinkAccess = React.useCallback((access: LinkAccess) => {
    const indexHandle = indexDocRef.current
    if (!indexHandle) return
    setNotebookLinkAccess(indexHandle.meta, access)
  }, [])

  return { ...fs, linkAccess, setLinkAccess, treeReady, indexProvider, sharedWithMembers }
}