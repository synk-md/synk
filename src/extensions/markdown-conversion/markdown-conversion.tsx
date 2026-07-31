import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import MarkdownIt from 'markdown-it'
import {
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from '@tiptap/pm/markdown'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import markdownItTaskLists from 'markdown-it-task-lists'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    markdownConversion: {
      /** Export current document to Markdown and store it in storage */
      toMarkdown: () => ReturnType
      /** Replace current document with Markdown (HTML tags supported for underline/highlight) */
      fromMarkdown: (markdown: string) => ReturnType
    }
  }

  interface Storage {
    markdownConversion: {
      lastExport?: string
    }
  }
}

/**
 * Markdown-It instance
 * - html: true to allow <u>, <mark>, and <span style="background-color:...">
 */
const mdIt = new MarkdownIt({ html: true }).use(markdownItTaskLists, {
  enabled: true,
  label: true,      // wrap text in <label> (helps click area)
  labelAfter: true, // put label after checkbox
})

/**
 * Aliases to match Tiptap node names (camelCase) with ProseMirror default names (snake_case).
 * We reuse default handlers where possible and add/override what we need.
 */
const codeBlockHandler = (state: any, node: any) => {
  const lang = node.attrs?.language || ''
  state.write('```' + (lang || '') + '\n')
  state.text(node.textContent, false)
  state.ensureNewLine()
  state.write('```')
  state.closeBlock(node)
}

const imageHandler = (state: any, node: any) => {
  const assetId = node.attrs?.assetId
  if (!assetId) return

  const alt = state.esc(node.attrs?.alt || "")
  const title = node.attrs?.title
    ? ` "${String(node.attrs.title).replaceAll('"', '\\"')}"`
    : ""
  state.write(`![${alt}](asset:${assetId}${title})`)
}

/** Serialize a single task item line: "- [ ] text" or "- [x] text" */
function writeTaskItem(state: any, node: any) {
  const checked =
    node.attrs?.checked === true ||
    node.attrs?.['data-checked'] === 'true' ||
    node.attrs?.checked === 'true'
  state.write(checked ? '- [x] ' : '- [ ] ')

  // Most TaskItem nodes contain a single paragraph as their first child.
  // Render its inline content if available; otherwise, fallback to textContent.
  const first = node.content?.firstChild ?? node
  if (state.renderInline) {
    state.renderInline(first)
  } else {
    state.text(first.textContent || '', false)
  }
  state.ensureNewLine()
}

const nodeHandlers = {
  ...defaultMarkdownSerializer.nodes,
  image: imageHandler,

  // Tiptap uses camelCase node names; provide aliases to default handlers:
  bulletList: defaultMarkdownSerializer.nodes.bullet_list,
  orderedList: defaultMarkdownSerializer.nodes.ordered_list,
  listItem: defaultMarkdownSerializer.nodes.list_item,
  hardBreak: defaultMarkdownSerializer.nodes.hard_break,

  // Code block with language attr (alias both names)
  code_block: codeBlockHandler,
  codeBlock: codeBlockHandler,

  taskList: (state: any, node: any) => {
    node.forEach((child: any) => writeTaskItem(state, child))
    state.closeBlock(node)
  },
  taskItem: (state: any, node: any) => {
    writeTaskItem(state, node)
  },
}

/**
 * Marks:
 * - italic: serialize as _..._ (Markdown)
 * - bold: alias to strong (Markdown)
 * - underline: serialize as <u>...</u> (HTML)
 * - highlight: serialize as <mark ...>...</mark> or <mark>...</mark>
 *   If a color attr exists (Highlight.configure({ multicolor: true })), include it in style.
 */
const markHandlers = {
  ...defaultMarkdownSerializer.marks,

  // If your schema mark name is 'italic', map it here. (Default PM name is 'em'.)
  italic: { open: '_', close: '_', mixable: true, expelEnclosingWhitespace: true },

  // Bold alias
  bold: defaultMarkdownSerializer.marks.strong,

  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },

  // Underline via HTML <u> (Tiptap Underline parses <u> by default)
  underline: { open: '<u>', close: '</u>', mixable: true, expelEnclosingWhitespace: true },

  // Highlight via <mark>, with color support using inline style (works with Highlight multicolor)
  highlight: {
    open: (_state: any, mark: any) => {
      const color = mark?.attrs?.color
      return color ? `<mark style="background-color:${color};">` : '<mark>'
    },
    close: '</mark>',
    mixable: true,
    expelEnclosingWhitespace: true,
  },

  superscript: { open: '<sup>', close: '</sup>', mixable: true, expelEnclosingWhitespace: true },
  subscript:   { open: '<sub>', close: '</sub>', mixable: true, expelEnclosingWhitespace: true },
}

const serializer = new MarkdownSerializer(nodeHandlers as any, markHandlers as any)

/** Helper: get markdown from an editor instance */
export function getMarkdownContent(editor: Editor | null): string {
  if (!editor) return ''
  try {
    return serializer.serialize(editor.state.doc)
  } catch (e) {
    console.error('Markdown export failed:', e)
    return ''
  }
}

function normalizeTaskListDOM(doc: Document) {
  // markdown-it-task-lists tags the <ul> with "contains-task-list", not "task-list".
  doc.querySelectorAll('ul.contains-task-list').forEach((ul) => {
    ul.setAttribute('data-type', 'taskList')
  })

  doc.querySelectorAll('li.task-list-item').forEach((li) => {
    li.setAttribute('data-type', 'taskItem')

    const checkbox = li.querySelector('input[type="checkbox"]') as
      | HTMLInputElement
      | null
    const checked =
      checkbox?.hasAttribute('checked') || (checkbox && checkbox.checked)
    li.setAttribute('data-checked', checked ? 'true' : 'false')

    // Ensure label wrapper around the checkbox at the start
    if (checkbox && !checkbox.parentElement?.matches('label')) {
      const label = doc.createElement('label')
      checkbox.replaceWith(label)
      label.appendChild(checkbox)
      li.insertBefore(label, li.firstChild)
    }

    // Wrap remaining content into <div> (and ensure <p> inside when needed)
    const contentDiv = doc.createElement('div')
    const toMove: ChildNode[] = []
    li.childNodes.forEach((child) => {
      const isLabel =
        child instanceof Element && child.tagName.toLowerCase() === 'label'
      if (!isLabel) toMove.push(child)
    })
    toMove.forEach((n) => contentDiv.appendChild(n))

    if (contentDiv.childNodes.length > 0) {
      const onlyTextNode =
        contentDiv.childNodes.length === 1 &&
        contentDiv.firstChild?.nodeType === Node.TEXT_NODE
      if (onlyTextNode) {
        const p = doc.createElement('p')
        p.textContent = contentDiv.textContent || ''
        contentDiv.textContent = ''
        contentDiv.appendChild(p)
      }
      li.appendChild(contentDiv)
    }
  })
}

/** Helper: parse Markdown to a PM doc using HTML DOM parsing for best mark fidelity */
export function markdownToProseMirrorDoc(editor: Editor, markdown: string) {
  // 1) Markdown -> HTML
  const html = mdIt.render(markdown)

  // 2) HTML -> DOM
  const dom = new window.DOMParser().parseFromString(html, 'text/html')

  normalizeTaskListDOM(dom)

  // 3) DOM -> ProseMirror Node using editor schema's parseDOM rules (from your extensions)
  const doc = PMDOMParser.fromSchema(editor.schema).parse(dom.body)
  return doc
}

export const MarkdownConversion = Extension.create({
  name: 'markdownConversion',

  addStorage() {
    return { lastExport: undefined as string | undefined }
  },

  addCommands() {
    return {
      toMarkdown:
        () =>
        ({ editor }) => {
          try {
            const md = serializer.serialize(editor.state.doc)
            editor.storage.markdownConversion.lastExport = md
            return true
          } catch (e) {
            console.error('toMarkdown failed:', e)
            return false
          }
        },

      fromMarkdown:
        (markdown: string) =>
        ({ editor }) => {
          try {
            const doc = markdownToProseMirrorDoc(editor, markdown)
            editor.commands.setContent(doc.toJSON())
            return true
          } catch (e) {
            console.error('fromMarkdown failed:', e)
            return false
          }
        },
    }
  },
})

export default MarkdownConversion
