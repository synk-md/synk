import { mergeAttributes } from "@tiptap/react"
import TiptapHorizontalRule from "@tiptap/extension-horizontal-rule"

const RULE_TEXT = /^(?:---|—-|___|\*\*\*)$/

export const HorizontalRule = TiptapHorizontalRule.extend({
  renderHTML() {
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, { "data-type": this.name }),
      ["hr"],
    ]
  },

  // Convert "---" on Enter (like Markdown) instead of as soon as it's typed,
  // so pressing Enter afterwards doesn't leave an extra empty paragraph.
  addInputRules() {
    return []
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { empty, $from } = editor.state.selection
        if (!empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph") return false
        if ($from.parentOffset !== $from.parent.content.size) return false
        if (!RULE_TEXT.test($from.parent.textContent.trim())) return false

        return editor
          .chain()
          .deleteRange({ from: $from.start(), to: $from.end() })
          .setHorizontalRule()
          .run()
      },
    }
  },
})

export default HorizontalRule
