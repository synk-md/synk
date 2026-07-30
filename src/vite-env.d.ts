/// <reference types="vite/client" />

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}

declare module '*.svg?react' {
  import * as React from 'react'
  const component: React.FunctionComponent<React.SVGProps<SVGSVGElement>>
  export default component
}