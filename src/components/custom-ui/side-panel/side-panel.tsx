import * as React from "react"
import "./side-panel.scss"

const MIN_WIDTH = 200
const MAX_WIDTH = 600

type Side = "left" | "right"

type SidePanelProps = {
  isOpen: boolean
  onClose: () => void
  width?: number // initial width
  children?: React.ReactNode
  side?: Side
}

export function SidePanel({
  isOpen,
  onClose: _onClose,
  width = 360,
  side = "left",
  children
}: SidePanelProps) {
  const [currentWidth, setCurrentWidth] = React.useState(width)
  const panelRef = React.useRef<HTMLDivElement>(null)

  // Dragging logic
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = currentWidth

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX

      const rawWidth =
        side === "left"
          ? startWidth + deltaX // drag right → wider
          : startWidth - deltaX // drag left  → wider

      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, rawWidth))
      setCurrentWidth(clamped)
    }

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }

  return (
    <div
      ref={panelRef}
      className={`side-panel side-panel--${side} ${isOpen ? "is-open" : ""}`}
      style={{ ["--sidepanel-width" as any]: `${currentWidth}px` }}
    >
      <div className="side-panel__inner">
        <div className="side-panel__body">{children}</div>
      </div>

      {/* Resize handle */}
      {isOpen && <div className="side-panel__resize-handle" onMouseDown={startResize} />}
    </div>
  )
}
