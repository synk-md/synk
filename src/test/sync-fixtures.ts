/**
 * Fixtures for the sync tests: a workspace with a published directory, and
 * clients wired to a shared relay.
 *
 * Building one client means correlating device keys, an admission, a directory
 * entry, a pinned client id and a transport. Centralised so every suite
 * exercises the same wiring the real app would, and a test that deviates does
 * so visibly.
 */

import * as Y from "yjs"
import { generateAeadKey, type Bytes, type SigningKey } from "@/lib/crypto"
import { bindDocumentClientId } from "@/lib/identity"
import { putAdmission, putDeviceRecord } from "@/lib/directory"
import {
  DirectoryAuthorResolver,
  DirectoryMembershipPolicy,
  MemoryRelay,
  SyncEngine,
  type EpochKeyProvider,
  type SyncCursorStore,
} from "@/lib/sync"
import { admitDevice, newAdmin, type Admin } from "./identity-fixtures"

export const RESOURCE = "notebook:1"

/** One epoch, one key. The real keyring arrives in M5. */
export function staticKeys(dek: Bytes = generateAeadKey(), epoch = 1): EpochKeyProvider {
  return {
    current: () => Promise.resolve({ epoch, dek }),
    forEpoch: (asked) => Promise.resolve(asked === epoch ? dek : undefined),
  }
}

export interface Workspace {
  admin: Admin
  directory: Y.Doc
  relay: MemoryRelay
  dek: Bytes
}

export async function newWorkspace(): Promise<Workspace> {
  return {
    admin: await newAdmin(),
    directory: new Y.Doc(),
    relay: new MemoryRelay(),
    dek: generateAeadKey(),
  }
}

export interface Client {
  name: string
  did: string
  clientId: number
  /** Exposed so adversarial tests can author envelopes the engine would not. */
  signingKey: SigningKey
  doc: Y.Doc
  text: Y.Text
  engine: SyncEngine
  transport: ReturnType<MemoryRelay["attach"]>
  keys: EpochKeyProvider
}

/**
 * Admit a device, publish it to the directory, pin its document to its derived
 * client id, and attach a sync engine over the shared relay.
 */
export async function joinWorkspace(
  workspace: Workspace,
  name: string,
  options: { member?: string; keys?: EpochKeyProvider; cursor?: SyncCursorStore } = {},
): Promise<Client> {
  const device = await admitDevice(workspace.admin, {
    member: options.member ?? `member:${name}`,
    label: name,
  })
  putDeviceRecord(workspace.directory, device.record)
  putAdmission(workspace.directory, device.admission)

  const doc = new Y.Doc()
  const clientId = await bindDocumentClientId(doc, device.key.publicKey)

  const keys = options.keys ?? staticKeys(workspace.dek)
  const transport = workspace.relay.attach(name)
  const client = {
    name,
    did: device.record.did,
    clientId,
    signingKey: device.key,
    doc,
    text: doc.getText("content"),
    transport,
    keys,
  }
  return { ...client, engine: engineFor(workspace, client, transport, options.cursor) }
}

function engineFor(
  workspace: Workspace,
  client: Omit<Client, "engine" | "transport">,
  transport: Client["transport"],
  cursor?: SyncCursorStore,
): SyncEngine {
  const authority = {
    directory: workspace.directory,
    trustedAdminDids: [workspace.admin.did],
  }
  return new SyncEngine({
    doc: client.doc,
    resourceId: RESOURCE,
    author: client.did,
    signingKey: client.signingKey,
    clientId: client.clientId,
    transport,
    authors: new DirectoryAuthorResolver(authority),
    policy: new DirectoryMembershipPolicy(authority),
    keys: client.keys,
    ...(cursor ? { cursor } : {}),
  })
}

/**
 * A reload: same device, same document (it lives in IndexedDB), but a fresh
 * engine and connection. Everything the old engine held in memory is gone.
 */
export function restartClient(
  workspace: Workspace,
  client: Client,
  options: { cursor?: SyncCursorStore } = {},
): Client {
  client.engine.close()
  client.transport.close()
  const transport = workspace.relay.attach(client.name)
  return { ...client, transport, engine: engineFor(workspace, client, transport, options.cursor) }
}

/**
 * Settle every client's queued work in both directions.
 *
 * One client publishing hands another something to receive, which can in turn
 * schedule more, so this loops until a full pass changes nothing rather than
 * guessing at a number of ticks.
 */
export async function settle(...clients: Client[]): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const client of clients) await client.engine.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const quiet = await Promise.all(clients.map((client) => client.engine.isQuiescent()))
    if (quiet.every(Boolean)) return
  }
}

export function textOf(client: Client): string {
  return client.text.toJSON()
}

export function stateVectorsEqual(a: Client, b: Client): boolean {
  const x = Y.encodeStateVector(a.doc)
  const y = Y.encodeStateVector(b.doc)
  if (x.length !== y.length) return false
  return x.every((byte, index) => byte === y[index])
}
