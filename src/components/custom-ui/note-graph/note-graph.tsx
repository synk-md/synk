import * as React from "react"
import { collectNoteEntries, type TreeNode } from "@/components/custom-ui/file-browser/tree"
import { ensureNoteLinks } from "@/lib/yjs-utils"
import { getNoteLinkIndex } from "@/lib/note-link-index"
import { buildNoteEdges } from "@/lib/note-graph"
import { GRAPH_FORCES, initialGraphPoint } from "@/lib/note-graph-physics"
import { useGraphPhysics } from "./use-graph-physics"
import { DEFAULT_GRAPH_DISPLAY, GraphOptions } from "./graph-options"
import "./note-graph.scss"

type Props = {
  notebookId: string
  tree: TreeNode
  currentNoteId?: string | null
  onNavigate: (id: string) => void
}

export function NoteGraph({ notebookId, tree, currentNoteId, onNavigate }: Props) {
  const notes = React.useMemo(() => collectNoteEntries(tree).sort((a, b) => a.id.localeCompare(b.id)), [tree])
  // Renaming a note should not reopen all document subscriptions.
  const idsKey = JSON.stringify(notes.map(note => note.id))
  const [links, setLinks] = React.useState<Record<string, string[]>>({})
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [display, setDisplay] = React.useState(DEFAULT_GRAPH_DISPLAY)
  const [forces, setForces] = React.useState(GRAPH_FORCES)
  const [viewport, setViewport] = React.useState({ zoom: 1, x: 0, y: 0 })
  const { zoom, ...pan } = viewport
  const [isDragging, setIsDragging] = React.useState(false)
  const dragRef = React.useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number; nodeId?: string; nodeX: number; nodeY: number } | null>(null)
  const suppressClickRef = React.useRef(false)
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      if (dragRef.current) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1)
      const rect = canvas.getBoundingClientRect()
      const scale = rect.width / canvas.offsetWidth || 1
      const cursorX = (event.clientX - rect.left) / scale
      const cursorY = (event.clientY - rect.top) / scale
      setViewport(previous => {
        const nextZoom = Math.max(0.1, Math.min(8, previous.zoom * Math.exp(-delta * 0.002)))
        const ratio = nextZoom / previous.zoom
        // Keep the same graph point underneath the cursor as its scale changes.
        return { zoom: nextZoom, x: cursorX - (cursorX - previous.x) * ratio, y: cursorY - (cursorY - previous.y) * ratio }
      })
    }
    // A non-passive listener lets zoom consume the wheel without scrolling the panel.
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  React.useEffect(() => {
    let disposed = false
    setLinks({})
    setLoading(true)
    setFailed(false)
    const ids: string[] = JSON.parse(idsKey)
    const index = getNoteLinkIndex(notebookId)
    const controller = new AbortController()
    const update = () => {
      if (!disposed) setLinks(Object.fromEntries(ids.map(id => [id, index.links.get(id) ?? []])))
    }
    index.links.observe(update)
    void index.idb.whenSynced.then(async () => {
      if (disposed) return
      update()
      await ensureNoteLinks(notebookId, ids, controller.signal)
    })
      .catch(() => { if (!disposed) setFailed(true) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => {
      disposed = true
      controller.abort()
      index.links.unobserve(update)
    }
  }, [notebookId, idsKey])

  const edges = React.useMemo(() => buildNoteEdges(notes.map(note => note.id), links), [notes, links])
  const size = Math.max(280, Math.sqrt(notes.length) * 100)
  const { positions: simulatedPositions, moveNode, releaseNode } = useGraphPhysics(idsKey, edges, size, forces)
  const positions = new Map(notes.map((note, index) => {
    return [note.id, simulatedPositions.get(note.id) ?? initialGraphPoint(index, notes.length, size)]
  }))
  const endDrag = () => {
    if (dragRef.current?.nodeId) releaseNode(dragRef.current.nodeId)
    dragRef.current = null
    setIsDragging(false)
  }

  return (
    <section className="note-graph" aria-label="Linked notes graph">
      <div
        className={`note-graph__canvas${isDragging ? " is-dragging" : ""}`}
        ref={canvasRef}
        onPointerDown={event => {
          if ((event.button !== 0 && event.button !== 1) || dragRef.current) return
          if (event.button === 1) event.preventDefault()
          suppressClickRef.current = false
          const nodeId = event.button === 0 ? (event.target as Element).closest("[data-graph-node-id]")?.getAttribute("data-graph-node-id") ?? undefined : undefined
          const point = nodeId ? positions.get(nodeId) : undefined
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, nodeId, nodeX: point?.x ?? 0, nodeY: point?.y ?? 0 }
          if (nodeId && point) moveNode(nodeId, point)
        }}
        onPointerMove={event => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return
          event.currentTarget.setPointerCapture(event.pointerId)
          suppressClickRef.current = true
          setIsDragging(true)
          if (drag.nodeId) {
            const rect = svgRef.current?.getBoundingClientRect()
            const extent = rect ? Math.min(rect.width, rect.height) || size : size
            moveNode(drag.nodeId, { x: drag.nodeX + dx * size / extent, y: drag.nodeY + dy * size / extent })
            return
          }
          // Account for the app's CSS zoom when converting pointer movement.
          const scale = event.currentTarget.getBoundingClientRect().width / event.currentTarget.offsetWidth || 1
          setViewport(previous => ({ ...previous, x: drag.panX + dx / scale, y: drag.panY + dy / scale }))
        }}
        onPointerUp={event => {
          if (dragRef.current?.pointerId !== event.pointerId) return
          endDrag()
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerLeave={() => {
          if (!suppressClickRef.current) endDrag()
        }}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onMouseDown={event => { if (event.button === 1) event.preventDefault() }}
        onAuxClick={event => { if (event.button === 1) event.preventDefault() }}
        onClickCapture={event => {
          if (suppressClickRef.current && event.detail > 0) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        {notes.length > 0 && (
          <svg ref={svgRef} viewBox={`0 0 ${size} ${size}`} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, transform: `translate(${pan.x}px, ${pan.y}px)` }} aria-label="Note connections">
            {edges.map(edge => {
              const source = positions.get(edge.source)!
              const target = positions.get(edge.target)!
              return <line key={JSON.stringify(edge)} x1={source.x} y1={source.y} x2={target.x} y2={target.y} style={{ strokeWidth: display.lineThickness }} className={edge.source === currentNoteId || edge.target === currentNoteId ? "is-active" : ""} />
            })}
            {notes.map(note => {
              const position = positions.get(note.id)!
              return (
                <g key={note.id} data-graph-node-id={note.id} transform={`translate(${position.x}, ${position.y})`} className={`note-graph__node${note.id === currentNoteId ? " is-current" : ""}`} role="button" tabIndex={0} aria-label={`Open ${note.name || "Untitled"}`} aria-current={note.id === currentNoteId ? "page" : undefined} onClick={() => onNavigate(note.id)} onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onNavigate(note.id)
                  }
                }}>
                  <title>{note.name || "Untitled"}</title>
                  <circle r={display.nodeSize} />
                  <text y={display.nodeSize + 15} textAnchor="middle">{(note.name || "Untitled").length > 14 ? `${note.name.slice(0, 13)}…` : note.name || "Untitled"}</text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
      <GraphOptions display={display} forces={forces} onDisplayChange={setDisplay} onForcesChange={setForces} />
      {(loading || failed || !notes.length) && (
        <p className="note-graph__hint" role="status">
          {loading ? "Loading note connections…" : failed ? "Some note connections could not be loaded." : "Create a note to start your graph."}
        </p>
      )}
    </section>
  )
}
