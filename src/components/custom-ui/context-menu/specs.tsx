import { FormatIcon } from "@/components/tiptap-icons/format-icon";
import { ToolbarIcon } from "@/components/tiptap-icons/toolbar-icon";

import {
  RiDeleteBin6Line,
  RiDownloadLine,
  RiInsertColumnLeft,
  RiInsertColumnRight,
  RiInsertRowBottom,
  RiInsertRowTop,
  RiMergeCellsHorizontal,
  RiSplitCellsHorizontal,
  RiTable2,
} from "@remixicon/react";

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

export const tableSpec: MenuSpec = (ctx) => {
  const { editor } = ctx;
  const icon = (Icon: typeof RiTable2) => <Icon className="tiptap-button-icon" />;
  const cmd = (id: string, label: string, Icon: typeof RiTable2, command: string, extra: Partial<MenuItem> = {}): MenuItem => ({
    id,
    label,
    icon: icon(Icon),
    // `editor.can()` checks against the current (cell) selection, so e.g.
    // "Merge cells" is only enabled with multiple cells selected.
    isEnabled: () => editor.isEditable && (editor.can() as any)[command](),
    run: () => { (editor.chain().focus() as any)[command]().run(); },
    ...extra,
  });

  return [
    Clipboard.cut(),
    Clipboard.copy(),
    { ...Clipboard.paste(), separatorAfter: true },
    {
      id: "table-rows",
      label: "Rows",
      icon: icon(RiInsertRowBottom),
      children: [
        cmd("row-before", "Insert row above", RiInsertRowTop, "addRowBefore"),
        cmd("row-after", "Insert row below", RiInsertRowBottom, "addRowAfter"),
        cmd("toggle-header-row", "Toggle header row", RiTable2, "toggleHeaderRow", { separatorBefore: true }),
        cmd("row-delete", "Delete row", RiDeleteBin6Line, "deleteRow", { dangerous: true, separatorBefore: true }),
      ],
    },
    {
      id: "table-columns",
      label: "Columns",
      icon: icon(RiInsertColumnRight),
      children: [
        cmd("col-before", "Insert column left", RiInsertColumnLeft, "addColumnBefore"),
        cmd("col-after", "Insert column right", RiInsertColumnRight, "addColumnAfter"),
        cmd("toggle-header-col", "Toggle header column", RiTable2, "toggleHeaderColumn", { separatorBefore: true }),
        cmd("col-delete", "Delete column", RiDeleteBin6Line, "deleteColumn", { dangerous: true, separatorBefore: true }),
      ],
    },
    {
      id: "table-cells",
      label: "Cells",
      icon: icon(RiMergeCellsHorizontal),
      children: [
        cmd("merge-cells", "Merge cells", RiMergeCellsHorizontal, "mergeCells"),
        cmd("split-cell", "Split cell", RiSplitCellsHorizontal, "splitCell"),
      ],
      separatorAfter: true,
    },
    cmd("delete-table", "Delete table", RiDeleteBin6Line, "deleteTable", { dangerous: true }),
  ];
};

export const noteLinkSpec: MenuSpec = (_ctx) => [
  Clipboard.cut(),
  Clipboard.copy(),
  { ...Clipboard.paste(), separatorAfter: true },
  Actions.noteLinkOpen(),
  Actions.noteLinkEdit(),
  Actions.noteLinkUnset(),
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
  Actions.linkEdit(),
  Actions.linkUnset(),

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
