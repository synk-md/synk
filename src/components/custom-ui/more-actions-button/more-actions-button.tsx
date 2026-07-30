import * as React from "react";
import type { Editor } from "@tiptap/react";
import { RiMore2Line } from "@remixicon/react";

import { Button } from "@/components/tiptap-ui-primitive/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/tiptap-ui-primitive/dropdown-menu";
import { MenuSurface } from "@/components/custom-ui/context-menu/menu-surface";
import type { MenuSpec, MenuContext } from "@/components/custom-ui/context-menu/menu-types";

type Props = {
  editor: Editor | null;
  spec: MenuSpec;
  extraContext?: Partial<MenuContext>;
};

export function MoreActionsButton({ editor, spec, extraContext }: Props) {
  const [open, setOpen] = React.useState(false);

  if (!editor) return null;

  const ctx: MenuContext = { editor, x: 0, y: 0, ...extraContext };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          className="more-actions-button"
          data-style="ghost"
          tooltip="More options"
          aria-expanded={open}
        >
          <RiMore2Line className="tiptap-button-icon" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" portal={false}>
        <MenuSurface spec={spec} ctx={ctx} onClose={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
