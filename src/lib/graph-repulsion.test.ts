import { expect, it } from "vitest"
import { applyGraphRepulsion } from "./graph-repulsion"

const grid = (side: number) => Array.from({ length: side * side }, (_, i) => ({ x: i % side * 25, y: Math.floor(i / side) * 25, vx: 0, vy: 0 }))

it("approximates direct repulsion accurately", () => {
  const exact = grid(10), approximate = grid(10)
  applyGraphRepulsion(exact, 650, 1, 0)
  applyGraphRepulsion(approximate, 650, 1)
  let error = 0, total = 0
  exact.forEach((point, i) => {
    error += Math.hypot(point.vx - approximate[i].vx, point.vy - approximate[i].vy)
    total += Math.hypot(point.vx, point.vy)
  })
  expect(error / total).toBeLessThan(0.05)
})

it("visits far fewer cells than pairs and scales subquadratically", () => {
  const small = applyGraphRepulsion(grid(20), 650, 1)
  const large = applyGraphRepulsion(grid(40), 650, 1)
  expect(large).toBeLessThan(1600 * 1600 / 4)
  expect(large / small).toBeLessThan(7)
})

it("bounds work for coincident nodes and keeps forces finite", () => {
  const points = Array.from({ length: 1000 }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }))
  expect(applyGraphRepulsion(points, 650, 1)).toBeLessThan(25000)
  expect(points.every(p => Number.isFinite(p.vx) && Number.isFinite(p.vy))).toBe(true)
})
