// lib/seed-welcome-note.ts
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { TextAlign } from "@tiptap/extension-text-align"
import { Highlight } from "@tiptap/extension-highlight"
import { getOrCreateYDoc } from "@/lib/yjs-utils"

const DEFAULT_WELCOME = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "attrs": {
                "textAlign": "left"
            },
            "content": [
                {
                    "type": "text",
                    "marks": [
                        {
                            "type": "italic"
                        }
                    ],
                    "text": "This is your new notebook."
                }
            ]
        },
        {
            "type": "paragraph",
            "attrs": {
                "textAlign": "left"
            },
            "content": [
                {
                    "type": "text",
                    "text": "Capture ideas, "
                },
                {
                    "type": "text",
                    "marks": [
                        {
                            "type": "highlight",
                            "attrs": {
                                "color": "var(--tt-color-highlight-yellow)"
                            }
                        }
                    ],
                    "text": "organize your thoughts"
                },
                {
                    "type": "text",
                    "text": ", and collaborate with others."
                }
            ]
        },
        {
            "type": "paragraph",
            "attrs": {
                "textAlign": "left"
            },
            "content": [
                {
                    "type": "text",
                    "marks": [
                        {
                            "type": "bold"
                        }
                    ],
                    "text": "Start writing and make it yours."
                }
            ]
        }
    ],
}

export async function seedWelcomeNote(notebookId: string, noteId: string) {
const { doc, idb } = getOrCreateYDoc(notebookId, noteId)
  await idb.whenSynced
  const meta = doc.getMap<any>("meta")

  const editor = new Editor({
    editable: false,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      Collaboration.configure({ document: doc as unknown as any }),
    ],
  })

  editor.commands.setContent(DEFAULT_WELCOME)

   // Give y-indexeddb a moment to persist the update
  await new Promise(requestAnimationFrame)
  // (extra backstop)
  await new Promise(r => setTimeout(r, 0))

  try { await (idb as any).whenSynced } catch {}

  const now = Date.now()
  meta.doc?.transact(() => {
    meta.set("title", "Welcome")
    meta.set("createdAt", now)
  })

  editor.destroy()
}
