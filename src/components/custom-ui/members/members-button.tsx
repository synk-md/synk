"use client"

import { RiGroupLine } from "@remixicon/react"

import { Button } from "@/components/tiptap-ui-primitive/button"

export type MembersButtonProps = {
  onOpen: () => void
}

/** Opens the notebook's member list. Present whether or not you can invite. */
export function MembersButton({ onOpen }: MembersButtonProps) {
  return (
    <Button
      type="button"
      data-style="ghost"
      aria-label="Who can see this notebook"
      tooltip="Who can see this notebook"
      onClick={onOpen}
    >
      <RiGroupLine className="tiptap-button-icon" />
    </Button>
  )
}

export default MembersButton
