import * as React from "react"
import type { NoteEdge } from "@/lib/note-graph"
import { GRAPH_FORCES, NoteGraphPhysics, type GraphPoint } from "@/lib/note-graph-physics"

export function useGraphPhysics(idsKey: string, edges: NoteEdge[], size: number, forces = GRAPH_FORCES) {
  const [positions, setPositions] = React.useState<Map<string, GraphPoint>>(new Map())
  const previous = React.useRef(positions)
  const simulation = React.useRef<NoteGraphPhysics | null>(null)
  const wake = React.useRef(() => {})
  const edgesKey = JSON.stringify(edges)

  React.useEffect(() => {
    const physics = new NoteGraphPhysics(JSON.parse(idsKey), JSON.parse(edgesKey), size, previous.current, forces)
    simulation.current = physics
    let frame: number | null = null
    let lastTime = 0
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const publish = () => {
      previous.current = physics.positions()
      setPositions(previous.current)
    }
    const tick = (time: number) => {
      frame = null
      // Fixed simulation steps keep motion consistent on high-refresh displays.
      if (time - lastTime < 1000 / 60) {
        frame = requestAnimationFrame(tick)
        return
      }
      lastTime = time
      let running = physics.step()
      if (reducedMotion) while (running) running = physics.step()
      publish()
      if (running) frame = requestAnimationFrame(tick)
    }
    wake.current = () => {
      if (frame === null) frame = requestAnimationFrame(tick)
    }
    publish()
    wake.current()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      simulation.current = null
      wake.current = () => {}
    }
  }, [idsKey, edgesKey, size, forces])

  const moveNode = (id: string, point: GraphPoint) => {
    simulation.current?.pin(id, point)
    wake.current()
  }
  const releaseNode = (id: string) => {
    simulation.current?.release(id)
    wake.current()
  }
  return { positions, moveNode, releaseNode }
}
