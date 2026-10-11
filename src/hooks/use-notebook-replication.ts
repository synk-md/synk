"use client"

import * as React from "react"

import type { EncryptedNoteState } from "@/hooks/use-encrypted-note-sync"
import { useNotebookKeys } from "@/hooks/use-notebook-keys"
import { useNotebookWorkspace } from "@/hooks/use-notebook-workspace"
import { currentDevice } from "@/lib/identity"
import type { ReadKeySource } from "@/lib/keys"
import {
  createDirectoryReplica,
  createTreeReplica,
  directoryChannel,
  encryptedSyncEnabled,
  liveKeys,
  openSyncSession,
  relayConnection,
  relayWatch,
  treeResourceId,
  type SyncSession,
  type SyncSessionStatus,
} from "@/lib/workspace"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

export interface NotebookReplication {
  /** False when no relay is configured, and the WebRTC rooms carry everything. */
  relay: boolean
  directory: SyncSessionStatus
  tree: EncryptedNoteState
  treeStatus: SyncSessionStatus
}

const warn = (what: string) => (error: unknown) => {
  console.warn(what, error)
}

/**
 * A notebook's directory and tree, through the relay.
 *
 * The directory runs whenever a relay is configured, so an invitation can be
 * redeemed while its owner is away. The tree runs once there is somebody to
 * share it with and this device holds the keys - and is republished whenever
 * the epoch moves on, because that is a new member who cannot read anything
 * sealed before it, and admitting them is the one time the admin is certainly
 * online.
 */
export function useNotebookReplication(
  notebookId: string | null,
  options: { tree: boolean },
): NotebookReplication {
  const relay = encryptedSyncEnabled()
  const active = relay && !!notebookId
  const [directory, setDirectory] = React.useState<SyncSessionStatus>("offline")

  React.useEffect(() => {
    const device = currentDevice()
    if (!active || !notebookId || !device) return
    let cancelled = false
    let stop: (() => void) | undefined
    const handle = createNotebookIndexDoc(notebookId)

    // Loaded first, so the state published on catch-up is what this device holds.
    void Promise.all([directoryChannel(notebookId), handle.idb.whenSynced]).then(([channel]) => {
      const connection = relayConnection()
      if (cancelled || !connection) return
      const transport = connection.transportFor(channel.resourceId)
      const engine = createDirectoryReplica({
        doc: handle.doc,
        channel,
        device: device.identity,
        transport,
        onError: warn("directory sync"),
      })
      const session = openSyncSession({
        engine,
        doc: handle.doc,
        transport,
        resourceId: channel.resourceId,
        readableEpochs: () => [],
        relay: relayWatch,
        canAuthor: true,
        recover: "publish-state",
        onStatus: setDirectory,
        onError: warn("directory sync"),
      })
      stop = () => {
        session.close()
        engine.close()
      }
    })

    return () => {
      cancelled = true
      stop?.()
      setDirectory("offline")
    }
  }, [active, notebookId])

  const wanted = active && options.tree
  const workspace = useNotebookWorkspace(wanted ? notebookId : null)
  const owner = workspace.workspace?.ownership.owner ?? null
  const keys = useNotebookKeys(wanted && owner ? notebookId : null, owner)
  const keyring = keys.keys?.access === "reader" ? keys.keys.keyring : null

  const tree: EncryptedNoteState = !wanted
    ? "off"
    : workspace.loading || (owner !== null && keys.loading)
      ? "pending"
      : keyring && owner
        ? "running"
        : "unavailable"

  const keyringRef = React.useRef<ReadKeySource | null>(null)
  const sessionRef = React.useRef<SyncSession | null>(null)
  React.useEffect(() => {
    if (!keyring) return
    const before = keyringRef.current?.currentEpoch
    // Swapped before refreshing, so the republish is sealed under the new epoch.
    keyringRef.current = keyring
    if (before !== undefined && keyring.currentEpoch !== before) sessionRef.current?.refresh()
  }, [keyring])

  const [treeStatus, setTreeStatus] = React.useState<SyncSessionStatus>("offline")
  const running = tree === "running"
  React.useEffect(() => {
    const device = currentDevice()
    if (!running || !notebookId || !owner || !device) return
    let cancelled = false
    let stop: (() => void) | undefined
    const handle = createNotebookIndexDoc(notebookId)

    void handle.idb.whenSynced.then(() => {
      const connection = relayConnection()
      if (cancelled || !connection || !keyringRef.current) return
      const resourceId = treeResourceId(notebookId)
      const transport = connection.transportFor(resourceId)
      const engine = createTreeReplica({
        tree: handle.tree,
        directory: handle.doc,
        notebookId,
        owner,
        device: device.identity,
        keys: liveKeys(() => keyringRef.current!),
        transport,
        onError: warn("tree sync"),
      })
      const session = openSyncSession({
        engine,
        doc: handle.tree,
        transport,
        resourceId,
        readableEpochs: () => keyringRef.current?.readableEpochs() ?? [],
        relay: relayWatch,
        canAuthor: true,
        recover: "publish-state",
        onStatus: setTreeStatus,
        onError: warn("tree sync"),
      })
      sessionRef.current = session
      stop = () => {
        sessionRef.current = null
        session.close()
        engine.close()
      }
    })

    return () => {
      cancelled = true
      stop?.()
      setTreeStatus("offline")
    }
  }, [running, notebookId, owner])

  return { relay, directory, tree, treeStatus }
}
