/**
 * Who this device has established owns each notebook.
 *
 * A genesis record says who signed it, not who was first, so anyone who can
 * write to the directory can add a rival one - and two claims make ownership
 * disputed, which stops the notebook for everyone. Remembering the owner the
 * first time it is established makes a later rival simply fail to verify.
 *
 * Off unless the app turns it on: it is device state, and a test that reuses a
 * notebook id must not inherit another test's owner.
 */

export interface OwnerPins {
  get(notebookId: string): string | null
  set(notebookId: string, owner: string): void
}

const KEY = "synk:owner:"

export const localOwnerPins: OwnerPins = {
  get: (notebookId) => {
    try {
      return localStorage.getItem(KEY + notebookId)
    } catch {
      return null
    }
  },
  set: (notebookId, owner) => {
    try {
      localStorage.setItem(KEY + notebookId, owner)
    } catch {
      // Without storage this device trusts the notebook afresh each time.
    }
  },
}

export function memoryOwnerPins(): OwnerPins {
  const pins = new Map<string, string>()
  return { get: (notebookId) => pins.get(notebookId) ?? null, set: (notebookId, owner) => pins.set(notebookId, owner) }
}

let pins: OwnerPins | null = null

export function configureOwnerPins(next: OwnerPins | null): void {
  pins = next
}

export function pinnedOwner(notebookId: string): string | null {
  return pins?.get(notebookId) ?? null
}

/** Never replaces an owner already remembered. */
export function pinOwner(notebookId: string, owner: string): void {
  if (pins && pins.get(notebookId) === null) pins.set(notebookId, owner)
}
