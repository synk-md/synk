/**
 * Invitation codes, kept on the device that issued them.
 *
 * Deliberately **not** in the notebook document. That syncs to every member, so
 * publishing a code there would hand it to exactly the people it is supposed to
 * distinguish between.
 *
 * Keeping it locally is close to free. A code on its own does not let anybody
 * in: it gets them as far as a pending request, and the fingerprint check at
 * the approve step is what actually admits them. And anyone able to read this
 * storage is on the owner's device, where they could simply issue a fresh
 * invitation - so storing it hands an attacker nothing they did not have.
 *
 * Against that, losing a code costs a cancel and a re-invite every time, which
 * is a real cost paid often.
 */

const KEY = "synk:invitation-codes:v1"

type Store = Record<string, Record<string, string>>

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Store) : {}
  } catch {
    // Private mode, cleared storage, a quota error. A missing code is a
    // degraded invitation, not a broken app.
    return {}
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Same: worth nothing to throw here.
  }
}

export function rememberInvitationCode(
  notebookId: string,
  invitationId: string,
  code: string,
): void {
  const store = read()
  store[notebookId] = { ...(store[notebookId] ?? {}), [invitationId]: code }
  write(store)
}

export function recallInvitationCode(
  notebookId: string,
  invitationId: string,
): string | null {
  return read()[notebookId]?.[invitationId] ?? null
}

/**
 * Drop a code once its invitation can no longer be used - granted, cancelled or
 * expired. Keeping one past that point is the only version of this that has a
 * downside and no upside.
 */
export function forgetInvitationCode(notebookId: string, invitationId: string): void {
  const store = read()
  const forNotebook = store[notebookId]
  if (!forNotebook || !(invitationId in forNotebook)) return
  const rest = { ...forNotebook }
  delete rest[invitationId]
  store[notebookId] = rest
  write(store)
}

/** Drop every code for a notebook. For deleting it, or signing out. */
export function forgetNotebookCodes(notebookId: string): void {
  const store = read()
  if (!(notebookId in store)) return
  const rest = { ...store }
  delete rest[notebookId]
  write(rest)
}

/** Prune codes for invitations that are no longer live. */
export function pruneInvitationCodes(
  notebookId: string,
  liveInvitationIds: Iterable<string>,
): void {
  const live = new Set(liveInvitationIds)
  const forNotebook = read()[notebookId]
  if (!forNotebook) return
  for (const id of Object.keys(forNotebook)) {
    if (!live.has(id)) forgetInvitationCode(notebookId, id)
  }
}
