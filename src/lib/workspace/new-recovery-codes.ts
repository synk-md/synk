/**
 * Recovery codes waiting to be shown, held in memory only.
 *
 * A code on the device would go with the device: a stolen laptop would carry
 * the one thing that takes the notebook back from whoever stole it. So it is
 * shown once, here, until the person says they have saved it, and then gone.
 */

const pending = new Map<string, string>()
const listeners = new Set<() => void>()

const changed = () => {
  for (const listener of listeners) listener()
}

export function showRecoveryCode(notebookId: string, text: string): void {
  pending.set(notebookId, text)
  changed()
}

export function recoveryCodeToShow(notebookId: string): string | null {
  return pending.get(notebookId) ?? null
}

export function recoveryCodeShown(notebookId: string): void {
  pending.delete(notebookId)
  changed()
}

export function onRecoveryCodes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
