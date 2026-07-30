import { FormatIcon } from "@/components/tiptap-icons/format-icon";
import { ToolbarIcon } from "@/components/tiptap-icons/toolbar-icon";

import { RiDownloadLine } from "@remixicon/react";

import type { MenuItem, MenuSpec } from "./menu-types";
import { Actions, Clipboard, Download } from "./actions";
import {
  getInlineTitleVisible,
  getToolbarVisible,
  setInlineTitleVisible,
  setToolbarVisible,
} from "@/components/custom-ui/ui-store";

function inlineTitleItem(separatorBefore = false): MenuItem {
  return {
    id: "toggle-inline-title",
    label: "Inline title",
    separatorBefore,
    run: () => setInlineTitleVisible(!getInlineTitleVisible()),
  };
}

export const imageSpec: MenuSpec = (_ctx) => [
  Actions.imageCut(),
  Actions.imageCopy(),
  { ...Clipboard.paste(), separatorAfter: true },
  Actions.imageOpenInNewTab(),
  {
    id: "image-align",
    label: "Align",
    children: [
      Actions.imageAlign("left"),
      Actions.imageAlign("center"),
      Actions.imageAlign("right"),
    ],
  },
  Actions.separator(),
  { ...Actions.deleteNode(), id: "delete-image", label: "Delete image", dangerous: true },
];

export const linkSpec: MenuSpec = () => [
  { id: "link-title", label: "Link", separatorAfter: true },
  Actions.linkSet(),
  Actions.linkUnset(),
  Actions.bold(),
  Actions.italic(),
];

export const headingSpec: MenuSpec = (ctx) => [
  { id: "heading-title", label: "Heading", separatorAfter: true },
  {
    id: "convert",
    label: "Convert",
    children: [1,2,3,4,5,6].map(l => ({
      id: `h${l}`,
      label: `H${l}`,
      run: () => {
        ctx.editor.chain().focus().toggleHeading({ level: l as any }).run();
        return undefined; // or return a value compatible with RunResult
      },
      isActive: () => ctx.editor.isActive("heading", { level: l }),
    })),
  },
  { id: "to-paragraph", label: "Turn into paragraph", run: () => { ctx.editor.chain().focus().setParagraph().run(); return undefined; } },
];

export const textSpec: MenuSpec = (_ctx) => [
  {
    id: "format",
    label: "Format",
    icon: <FormatIcon className="tiptap-button-icon" />,
    // optional: icon: <HeadingIcon /> or <BoldIcon />
    children: [
      Actions.bold(),
      Actions.italic(),
      Actions.underline(),
      { ...Actions.inlineCode() },
    ],
    separatorAfter: true,
  },

  Clipboard.cut(),
  Clipboard.copy(),
  Clipboard.paste(),

  Actions.separator(),

  Actions.linkSet(),

  // {
  //   id: "convert",
  //   label: "Convert",
  //   children: [
  //     { id: "bullet",  label: "Bullet list",  run: () => ctx.editor.chain().focus().toggleBulletList().run() as any },
  //     { id: "ordered", label: "Ordered list", run: () => ctx.editor.chain().focus().toggleOrderedList().run() as any},
  //     { id: "task",    label: "Task list",    run: () => ctx.editor.chain().focus().toggleTaskList?.().run() as any, isVisible: () => !!ctx.editor.commands.toggleTaskList },
  //   ],
  //   separatorAfter: true,
  // },

];

export const defaultSpec: MenuSpec = (_ctx) => [
  
];

export const editorSpec: MenuSpec = (_ctx) => [
  inlineTitleItem(),
];

export const toolbarSpec: MenuSpec = (_ctx) => [
  { id: "hide-toolbar", label: "Hide toolbar", icon: <ToolbarIcon className="tiptap-button-icon"/>, run: () => setToolbarVisible(false)},
];

export const toolbarMoreSpec: MenuSpec = (_ctx) => [
  Download.copyAsMarkdown(),
  {
    id: "download",
    label: "Download",
    icon: <RiDownloadLine className="tiptap-button-icon"/>,
    children: [
      Download.markdown(),
      Download.json(),
      Download.text(),
    ],
  },
];

export type ToolbarUIActions = {
  getToolbarVisible: () => boolean;
  setToolbarVisible: (v: boolean) => void;
};

export const tabbarSpec: MenuSpec = (_ctx) => {
  const items: MenuItem[] = [
  ];

  // Conditionally add Show/Hide toolbar
  if (getToolbarVisible()) {
    items.push({
      id: "hide-toolbar",
      label: "Hide toolbar",
      icon: <ToolbarIcon className="tiptap-button-icon"/>,
      separatorBefore: items.length > 0,
      run: () => setToolbarVisible(false),
    });
  } else {
    items.push({
      id: "show-toolbar",
      label: "Show toolbar",
      icon: <ToolbarIcon className="tiptap-button-icon"/>,
      separatorBefore: items.length > 0,
      run: () => setToolbarVisible(true),
    });
  }

  return items;
};
