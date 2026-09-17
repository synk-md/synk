
const lastOpenedNoteKey = (notebookId: string) => `lastOpenedNote:${notebookId}`

/** The note last opened in this notebook on this device, if any. */
export function getLastOpenedNoteId(notebookId: string): string | null {
  try {
    return localStorage.getItem(lastOpenedNoteKey(notebookId))
  } catch (error) {
    // Storage can be unavailable outright (private browsing, blocked cookies).
    console.warn("Could not read the last opened note", error)
    return null
  }
}

export function setLastOpenedNoteId(notebookId: string, noteId: string) {
  try {
    localStorage.setItem(lastOpenedNoteKey(notebookId), noteId)
  } catch (error) {
    console.warn("Could not remember the last opened note", error)
  }
}

export function forgetLastOpenedNoteId(notebookId: string) {
  try {
    localStorage.removeItem(lastOpenedNoteKey(notebookId))
  } catch (error) {
    console.warn("Could not forget the last opened note", error)
  }
}
