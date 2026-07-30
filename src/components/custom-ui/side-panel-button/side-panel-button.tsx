import { Button } from '@/components/tiptap-ui-primitive/button'
import { RiSideBarLine } from '@remixicon/react'
import { RiSideBarFill } from '@remixicon/react'

import './side-panel-button.scss'

type Props = {
  isOpen: boolean
  onToggle: () => void
  isFlipped?: boolean
}

export function SidePanelButton({ isOpen, onToggle, isFlipped }: Props) {
  return (
    <>
      <Button
        className='side-panel-button'
        data-style="ghost"
        tooltip={isOpen ? "Hide side panel" : "Show side panel"}
        aria-expanded={isOpen}
        aria-controls="simple-editor-side-panel"
        onClick={onToggle}
      >
        {isOpen ? (
          <RiSideBarFill className={`tiptap-button-icon ${isFlipped ? 'flipped' : ''}`} />
        ) : (
          <RiSideBarLine className={`tiptap-button-icon ${isFlipped ? 'flipped' : ''}`} />
        )}
      </Button>
    </>
  )
}