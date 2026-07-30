"use client"

import * as React from "react"
import { RiCheckLine, RiSettings4Line } from "@remixicon/react"

import { Card, CardBody } from "@/components/tiptap-ui-primitive/card"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { Separator } from "@/components/tiptap-ui-primitive/separator"
import { useNotebooks } from "@/hooks/use-notebooks"
import { useSwitchNotebook } from "@/hooks/use-switch-notebook"
import type { Notebook } from "@/components/custom-ui/file-browser/tree"

import "./notebook-switch-menu.scss"

type NotebookSwitchMenuProps = {
  onManageNotebooks: () => void
  onClose: () => void
}

export function NotebookSwitchMenu({ onManageNotebooks, onClose }: NotebookSwitchMenuProps) {
  const { notebooks, currentId } = useNotebooks()
  const switchNotebook = useSwitchNotebook()

  const sorted = React.useMemo(
    () => [...notebooks].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [notebooks]
  )

  const handleSelect = React.useCallback(
    async (notebook: Notebook) => {
      onClose()
      await switchNotebook(notebook)
    },
    [onClose, switchNotebook]
  )

  return (
    <Card>
      <CardBody className="notebook-switch-menu">
        <Button
          type="button"
          data-style="ghost"
          className="nsm-manage-btn"
          aria-label="Manage notebooks"
          onClick={() => {
            onClose()
            onManageNotebooks()
          }}
        >
          <RiSettings4Line className="tiptap-button-icon" />
          <span className="tiptap-button-text">Manage notebooks</span>
        </Button>

        <Separator orientation="horizontal" decorative className="nsm-separator" />

        <div className="nsm-list" role="listbox" aria-label="Switch notebook">
          {sorted.length === 0 ? (
            <div className="nsm-empty">No notebooks yet.</div>
          ) : (
            sorted.map((notebook) => {
              const isActive = notebook.id === currentId
              return (
                <button
                  key={notebook.id}
                  type="button"
                  className={["nsm-item", isActive ? "is-active" : ""].join(" ")}
                  onClick={() => handleSelect(notebook)}
                >
                  <span className="nsm-item-name">{notebook.name}</span>
                  {isActive && <RiCheckLine className="nsm-item-check" />}
                </button>
              )
            })
          )}
        </div>
      </CardBody>
    </Card>
  )
}

export default NotebookSwitchMenu
