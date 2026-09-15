import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

import { isMac, sanitizeUrl } from '@/lib/tiptap-utils'

// Set on the editor DOM while the open-link modifier is held, so CSS can show
// a pointer cursor over links. ProseMirror only manages the classes it adds
// itself, so a class toggled here survives its attribute updates.
const MODIFIER_HELD_CLASS = 'is-link-modifier-held'

function isOpenLinkModifier(event: KeyboardEvent | MouseEvent) {
  return isMac() ? event.metaKey : event.ctrlKey
}

// Opens external links in a new tab on Ctrl+click (⌘+click on macOS, where
// Ctrl+click is the context menu). Replaces the Link extension's own
// `openOnClick`, which opens on a plain click and calls `window.open` without
// `noopener`, giving the opened page a handle on this window.
export const LinkClick = Extension.create({
  name: 'linkClick',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('linkClick'),
        view: (view) => {
          const sync = (event: KeyboardEvent | MouseEvent) => {
            view.dom.classList.toggle(MODIFIER_HELD_CLASS, view.editable && isOpenLinkModifier(event))
          }
          const clear = () => view.dom.classList.remove(MODIFIER_HELD_CLASS)

          // Key events cover pressing/releasing the modifier while hovering;
          // mousemove catches up when it changed while the window was unfocused.
          window.addEventListener('keydown', sync)
          window.addEventListener('keyup', sync)
          window.addEventListener('blur', clear)
          view.dom.addEventListener('mousemove', sync)

          return {
            destroy: () => {
              window.removeEventListener('keydown', sync)
              window.removeEventListener('keyup', sync)
              window.removeEventListener('blur', clear)
              view.dom.removeEventListener('mousemove', sync)
              clear()
            },
          }
        },
        props: {
          handleDOMEvents: {
            // Handled on mousedown rather than via `handleClick`: ProseMirror
            // treats a modifier mousedown as a node-selection click and never
            // reaches `handleClick` for it. Returning true here also skips
            // ProseMirror's own mousedown handling, so the caret stays put.
            mousedown: (view, event) => {
              // In a read-only view the browser already follows a modifier
              // click on the anchor natively, so opening it here too would
              // open it twice.
              if (event.button !== 0 || !isOpenLinkModifier(event) || !view.editable) return false

              const anchor = (event.target as HTMLElement | null)?.closest('a[href]')
              if (!anchor || !view.dom.contains(anchor)) return false

              const href = sanitizeUrl(anchor.getAttribute('href') ?? '', window.location.href)
              if (href === '#') return false

              event.preventDefault()
              window.open(href, '_blank', 'noopener,noreferrer')
              return true
            },
          },
        },
      }),
    ]
  },
})
