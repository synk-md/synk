type Point = { x: number; y: number; vx: number; vy: number }
type Cell = {
  x: number; y: number; size: number; count: number; cx: number; cy: number
  children?: Cell[]
}

function build(points: Point[], x: number, y: number, size: number, depth = 0): Cell {
  const cell: Cell = { x, y, size, count: points.length, cx: 0, cy: 0 }
  for (const p of points) { cell.cx += p.x; cell.cy += p.y }
  cell.cx /= cell.count
  cell.cy /= cell.count
  // Bound depth for coincident/near-coincident particles. Such buckets are
  // treated as one mass, excluding the current particle during traversal.
  if (points.length <= 1 || depth >= 24 || size < 0.001) return cell
  const half = size / 2
  const buckets: Point[][] = [[], [], [], []]
  for (const p of points) buckets[(p.x >= x + half ? 1 : 0) + (p.y >= y + half ? 2 : 0)].push(p)
  cell.children = buckets.flatMap((bucket, i) => bucket.length
    ? [build(bucket, x + (i % 2) * half, y + Math.floor(i / 2) * half, half, depth + 1)] : [])
  return cell
}

/** Barnes–Hut: nearby cells are opened; distant cells act as a single mass.
 * Returns visited-cell count for deterministic performance regression tests. */
export function applyGraphRepulsion(points: Point[], strength: number, alpha: number, theta = 0.6): number {
  if (points.length < 2 || strength === 0) return 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  const root = build(points, minX, minY, Math.max(1, maxX - minX, maxY - minY) + 0.001)
  let visits = 0
  points.forEach((point, index) => {
    const visit = (cell: Cell) => {
      visits++
      const contains = point.x >= cell.x && point.x < cell.x + cell.size && point.y >= cell.y && point.y < cell.y + cell.size
      let dx = cell.cx - point.x, dy = cell.cy - point.y
      const distanceSquared = dx * dx + dy * dy
      if (cell.children && (contains || cell.size * cell.size >= theta * theta * distanceSquared)) {
        cell.children.forEach(visit)
        return
      }
      const mass = cell.count - (contains ? 1 : 0)
      if (!mass) return
      if (contains) {
        dx = (cell.cx * cell.count - point.x) / mass - point.x
        dy = (cell.cy * cell.count - point.y) / mass - point.y
      }
      if (dx === 0 && dy === 0) {
        const angle = index * 2.399963229728653
        dx = Math.cos(angle) * 0.1; dy = Math.sin(angle) * 0.1
      }
      const distance = Math.hypot(dx, dy)
      const force = Math.min(8, strength / Math.max(100, distance * distance)) * alpha * mass
      point.vx -= dx / distance * force
      point.vy -= dy / distance * force
    }
    visit(root)
  })
  return visits
}
