import type { NoteEdge } from "./note-graph"
import { applyGraphRepulsion } from "./graph-repulsion"

export type GraphPoint = { x: number; y: number }
type Particle = GraphPoint & { vx: number; vy: number; fixed?: GraphPoint }

export const GRAPH_FORCES = {
  centerForce: 0.008,
  repelForce: 650,
  linkDistance: 65,
  linkStrength: 0.06,
}

export function initialGraphPoint(index: number, count: number, size: number): GraphPoint {
  // A golden-angle spiral avoids the symmetry of a circle and starts nearby
  // nodes apart, allowing separate clusters to emerge from their connections.
  const radius = count > 1 ? 16 * Math.sqrt(index + 1) : 0
  const angle = index * Math.PI * (3 - Math.sqrt(5))
  return { x: size / 2 + radius * Math.cos(angle), y: size / 2 + radius * Math.sin(angle) }
}

export class NoteGraphPhysics {
  readonly nodes: Map<string, Particle>
  private alpha = 1
  private edges: NoteEdge[]
  private size: number
  private forces: typeof GRAPH_FORCES

  constructor(
    ids: string[],
    edges: NoteEdge[],
    size: number,
    previous: Map<string, GraphPoint> = new Map(),
    forces = GRAPH_FORCES,
  ) {
    this.edges = edges
    this.size = size
    this.forces = forces
    this.nodes = new Map(ids.map((id, index) => [id, {
      ...(previous.get(id) ?? initialGraphPoint(index, ids.length, size)), vx: 0, vy: 0,
    }]))
  }

  pin(id: string, point: GraphPoint) {
    const node = this.nodes.get(id)
    if (!node) return
    Object.assign(node, point, { fixed: point, vx: 0, vy: 0 })
    this.alpha = 1
  }

  release(id: string) {
    const node = this.nodes.get(id)
    if (node) node.fixed = undefined
    this.alpha = 1
  }

  step(): boolean {
    const particles = [...this.nodes.values()]
    const { centerForce, repelForce, linkDistance, linkStrength } = this.forces
    for (const node of particles) {
      node.vx += (this.size / 2 - node.x) * centerForce * this.alpha
      node.vy += (this.size / 2 - node.y) * centerForce * this.alpha
    }
    applyGraphRepulsion(particles, repelForce, this.alpha)
    for (const edge of this.edges) {
      const a = this.nodes.get(edge.source), b = this.nodes.get(edge.target)
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1
      const force = (distance - linkDistance) * linkStrength * this.alpha
      const fx = dx / distance * force, fy = dy / distance * force
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }
    for (const node of particles) {
      if (node.fixed) {
        Object.assign(node, node.fixed, { vx: 0, vy: 0 })
      } else {
        // Damping dissipates momentum; a speed cap keeps dragging stable.
        node.vx = Math.max(-12, Math.min(12, node.vx * 0.75))
        node.vy = Math.max(-12, Math.min(12, node.vy * 0.75))
        node.x += node.vx
        node.y += node.vy
      }
    }
    this.alpha *= 0.975
    return this.alpha > 0.002
  }

  positions(): Map<string, GraphPoint> {
    return new Map([...this.nodes].map(([id, node]) => [id, { x: node.x, y: node.y }]))
  }
}
