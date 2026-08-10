import * as React from "react"
import { mergeAttributes, Node, type NodeViewProps } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import { RiFileDamageLine } from "@remixicon/react"

import { collectNoteEntries, findNode, type NoteEntry, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { fuzzyScore } from "@/components/custom-ui/quick-pick/quick-pick"
import { renderNoteLinkSuggestion } from "@/components/tiptap-node/note-link-node/note-link-suggestion"
import "@/components/tiptap-node/note-link-node/note-link-node.scss"

// Read fresh on every lookup instead of being captured in extension options,
// so renaming/creating notes elsewhere in the notebook doesn't force the
// `extensions` array (and therefore the whole editor instance) to be
// recreated just to pick up a title change.
export type NoteLinkApi = {
  tree: TreeNode
  onNavigate: (noteId: string) => void
}

export interface NoteLinkOptions {
  // A getter, not a ref: Tiptap's `.configure()` deep-merges plain option
  // objects (`mergeDeep`), which would silently clone a `{ current }` ref
  // object and disconnect it from the original — so this is a stable
  // function instead, always read fresh via closure at call time.
  api: () => NoteLinkApi | null
}

export function noteTitleFor(tree: TreeNode | null, noteId: string | null): string | null {
  if (!tree || !noteId) return null
  const { node } = findNode(tree, noteId)
  if (!node || node.isFolder || node.assetId) return null
  return node.name || "Untitled"
}

function NoteLinkView({ node, extension, selected }: NodeViewProps) {
  const noteId = node.attrs.noteId as string | null
  const label = node.attrs.label as string | null
  const api = (extension.options as NoteLinkOptions).api()

  // While the note is open in this editor the tree is always available, so
  // a lookup that comes back empty means the target note was deleted. The
  // frozen `label` attribute (the note's title at the time the link was
  // inserted) is the fallback used both before the tree loads and for
  // headless rendering (export/markdown), where there is no tree at all.
  const liveTitle = api ? noteTitleFor(api.tree, noteId) : null
  const displayTitle = liveTitle ?? label ?? "Untitled"
  const isBroken = api != null && noteId != null && liveTitle == null

  const handleClick = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      if (noteId && !isBroken) api?.onNavigate(noteId)
    },
    [api, noteId, isBroken],
  )

  return (
    <NodeViewWrapper as="span" className="note-link-wrapper">
      <span
        className={`note-link${selected ? " is-selected" : ""}${isBroken ? " is-broken" : ""}`}
        data-note-id={noteId}
        onClick={handleClick}
        role="link"
        tabIndex={-1}
      >
        {isBroken && <RiFileDamageLine className="note-link-broken-icon" />}
        {isBroken ? "Note not found" : displayTitle}
      </span>
    </NodeViewWrapper>
  )
}

export const NoteLinkSuggestionPluginKey = new PluginKey("noteLinkSuggestion")

export const NoteLink = Node.create<NoteLinkOptions>({
  name: "noteLink",

  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addOptions() {
    return {
      api: () => null,
    }
  },

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-note-id"),
        renderHTML: (attributes) => {
          if (!attributes.noteId) return {}
          return { "data-note-id": attributes.noteId }
        },
      },
      // Frozen at insertion time. See `NoteLinkView` for why this matters.
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-label"),
        renderHTML: (attributes) => {
          if (!attributes.label) return {}
          return { "data-label": attributes.label }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: `span[data-type="${this.name}"]` }]
  },

  renderHTML({ HTMLAttributes }) {
    const label = HTMLAttributes["data-label"] ?? "Untitled"
    return ["span", mergeAttributes({ "data-type": this.name }, HTMLAttributes), label]
  },

  renderText({ node }) {
    return (node.attrs.label as string | null) ?? "Untitled"
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteLinkView)
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<NoteEntry, NoteEntry>({
        editor: this.editor,
        char: "[[",
        pluginKey: NoteLinkSuggestionPluginKey,
        allowSpaces: true,
        items: ({ query }) => {
          const api = this.options.api()
          return api ? noteLinkSuggestionItems(api.tree, query) : []
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: this.name, attrs: { noteId: props.id, label: props.name } },
              { type: "text", text: " " },
            ])
            .run()
        },
        render: renderNoteLinkSuggestion,
      }),
    ]
  },
})

export function noteLinkSuggestionItems(tree: TreeNode, query: string): NoteEntry[] {
  return collectNoteEntries(tree)
    .map((entry) => ({ entry, score: fuzzyScore(entry.name, query) }))
    .filter((result): result is { entry: NoteEntry; score: number } => result.score !== null)
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 8)
    .map((result) => result.entry)
}
