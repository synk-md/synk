/**
 * The newest epoch this device has verified for each notebook.
 *
 * Epochs only ever go forward. A timeline that ends before one this device has
 * already seen means the newest record went missing - deleted by someone who
 * can write to the directory - and trusting it would mean writing under a key
 * that whoever that epoch removed still holds. So it is refused instead: this
 * device stops writing rather than going back.
 *
 * Off unless the app turns it on, like remembered owners, and for the same
 * reason.
 */

export interface RememberedEpochs {
  get(notebookId: string): number | null
  set(notebookId: string, epoch: number): void
}

const KEY = "synk:epoch:"

export const localRememberedEpochs: RememberedEpochs = {
  get: (notebookId) => {
    try {
      const value = Number(localStorage.getItem(KEY + notebookId))
      return Number.isSafeInteger(value) && value > 0 ? value : null
    } catch {
      return null
    }
  },
  set: (notebookId, epoch) => {
    try {
      localStorage.setItem(KEY + notebookId, String(epoch))
    } catch {
      // Without storage this device cannot tell a timeline went back.
    }
  },
}

export function memoryRememberedEpochs(): RememberedEpochs {
  const epochs = new Map<string, number>()
  return { get: (notebookId) => epochs.get(notebookId) ?? null, set: (notebookId, epoch) => epochs.set(notebookId, epoch) }
}

let remembered: RememberedEpochs | null = null

export function configureRememberedEpochs(next: RememberedEpochs | null): void {
  remembered = next
}

export function rememberedEpoch(notebookId: string): number | null {
  return remembered?.get(notebookId) ?? null
}

/** Only ever raises it. */
export function rememberEpoch(notebookId: string, epoch: number): void {
  if (!remembered) return
  const held = remembered.get(notebookId)
  if (held === null || epoch > held) remembered.set(notebookId, epoch)
}
