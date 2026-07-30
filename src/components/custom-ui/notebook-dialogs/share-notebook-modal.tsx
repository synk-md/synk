import * as React from "react"
import type { LinkAccess } from "@/lib/note-meta"
import { getNotebookLinkAccess, setNotebookLinkAccess } from "@/lib/notebook-meta"
import { createNotebookIndexDoc } from "@/lib/yjs-utils"

import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"
import { RiEdit2Line, RiEyeLine, RiLock2Line, RiCloseLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/tiptap-ui-primitive/dropdown-menu"

// Reuses the note-level share modal's markup/classnames for visual
// consistency (see collaboration-dropdown-menu.tsx), scoped to a notebook.
import "@/components/custom-ui/collaboration-dropdown-menu/collaboration-dropdown-menu.scss"

export type ShareNotebookModalProps = {
  notebookId: string
  notebookName: string
  open: boolean
  onClose: () => void
}

const accessDescriptionMap: Record<LinkAccess, string> = {
  restricted: "Link sharing is off — only you can access this notebook.",
  view: "Anyone with the link can view every note in this notebook.",
  edit: "Anyone with the link can view and edit every note in this notebook, in real time.",
}

const accessOptions: {
  value: LinkAccess
  label: string
  description: string
  Icon: typeof RiLock2Line
}[] = [
  {
    value: "restricted",
    label: "Restricted access",
    description: "Only you can access this notebook.",
    Icon: RiLock2Line,
  },
  {
    value: "view",
    label: "Anyone with the link can view",
    description: "People with the link can view every note.",
    Icon: RiEyeLine,
  },
  {
    value: "edit",
    label: "Anyone with the link can edit",
    description: "People with the link can view, edit, and reorganize the notebook.",
    Icon: RiEdit2Line,
  },
]

export function ShareNotebookModal({ notebookId, notebookName, open, onClose }: ShareNotebookModalProps) {
  const [linkAccess, setLinkAccessState] = React.useState<LinkAccess>("restricted")
  const [copied, setCopied] = React.useState(false)
  const [isAccessMenuOpen, setIsAccessMenuOpen] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let disposed = false
    const { meta, idb } = createNotebookIndexDoc(notebookId)

    const applyAccess = () => {
      if (!disposed) setLinkAccessState(getNotebookLinkAccess(meta))
    }

    applyAccess()
    meta.observe(applyAccess)
    idb.whenSynced.then(applyAccess).catch(() => {})

    return () => {
      disposed = true
      meta.unobserve(applyAccess)
    }
  }, [open, notebookId])

  const resolvedShareUrl = React.useMemo(
    () => `${window.location.origin}/s/${notebookId}`,
    [notebookId],
  )

  const handleLinkAccessChange = (access: LinkAccess) => {
    const { meta } = createNotebookIndexDoc(notebookId)
    setNotebookLinkAccess(meta, access)
    setLinkAccessState(access)
  }

  const handleCopy = () => {
    if (!navigator?.clipboard?.writeText) return
    navigator.clipboard.writeText(resolvedShareUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (!open) return null

  return (
    <div className="share-modal-backdrop" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-modal-header">
          <div className="share-modal-heading">
            <h3>Share "{notebookName}"</h3>
            <div className="share-modal-subtitle">{accessDescriptionMap[linkAccess]}</div>
          </div>
          <div className="share-modal-header-actions">
            <Button type="button" data-style="ghost" aria-label="Close" tooltip="Close" onClick={onClose}>
              <RiCloseLine className="tiptap-button-icon" />
            </Button>
          </div>
        </div>

        <div className="share-modal-body">
          <div className="share-input-row">
            <input
              readOnly
              value={resolvedShareUrl}
              onFocus={(e) => e.currentTarget.select()}
              data-muted={linkAccess === "restricted" || undefined}
            />
            <Button
              type="button"
              onClick={handleCopy}
              aria-label={linkAccess === "restricted" ? "Link sharing is off" : "Copy"}
              tooltip={linkAccess === "restricted" ? "Link sharing is off" : "Copy"}
              disabled={linkAccess === "restricted"}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>

          <div className="share-access-setting" aria-label="Link access">
            <label htmlFor="notebook-link-access-select">Link access</label>
            <DropdownMenu open={isAccessMenuOpen} onOpenChange={setIsAccessMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button type="button" className="link-access-trigger" aria-label="Select link access">
                  {React.createElement(
                    accessOptions.find((option) => option.value === linkAccess)?.Icon ?? RiLock2Line,
                    { className: "tiptap-button-icon" },
                  )}
                  <span className="tiptap-button-text">
                    {accessOptions.find((option) => option.value === linkAccess)?.label ?? "Select access"}
                  </span>
                  <ChevronDownIcon className="link-access-caret" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent className="collab-dropdown-content link-access-menu" align="start" portal>
                {accessOptions.map(({ value, label, description, Icon }) => (
                  <DropdownMenuItem key={value} className="link-access-item" onSelect={() => handleLinkAccessChange(value)}>
                    <Icon className="tiptap-button-icon" />
                    <div className="link-access-text">
                      <span className="link-access-label">{label}</span>
                      <span className="link-access-description">{description}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ShareNotebookModal
