import { describe, expect, it } from "vitest"
import { GRAPH_FORCES, NoteGraphPhysics } from "./note-graph-physics"

const noForces = { centerForce: 0, repelForce: 0, linkDistance: 65, linkStrength: 0 }
const distance = (physics: NoteGraphPhysics) => {
  const a = physics.nodes.get("a")!, b = physics.nodes.get("b")!
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe("graph forces", () => {
  it("pulls a disconnected note toward the center", () => {
    const physics = new NoteGraphPhysics(["a"], [], 280, new Map([["a", { x: 20, y: 20 }]]))
    physics.step()
    expect(physics.nodes.get("a")!.x).toBeGreaterThan(20)
    expect(physics.nodes.get("a")!.y).toBeGreaterThan(20)
  })

  it("repels even coincident notes without invalid coordinates", () => {
    const physics = new NoteGraphPhysics(["a", "b"], [], 280,
      new Map([["a", { x: 140, y: 140 }], ["b", { x: 140, y: 140 }]]),
      { ...noForces, repelForce: GRAPH_FORCES.repelForce })
    physics.step()
    expect(distance(physics)).toBeGreaterThan(0)
    expect(Number.isFinite(distance(physics))).toBe(true)
  })

  it("uses link distance and strength to pull or push connected notes", () => {
    const create = (linkDistance: number, linkStrength: number) => new NoteGraphPhysics(
      ["a", "b"], [{ source: "a", target: "b" }], 280,
      new Map([["a", { x: 100, y: 140 }], ["b", { x: 200, y: 140 }]]),
      { ...noForces, linkDistance, linkStrength },
    )
    const weak = create(65, 0.01), strong = create(65, 0.06), long = create(150, 0.06)
    weak.step(); strong.step(); long.step()
    expect(distance(weak)).toBeLessThan(100)
    expect(distance(strong)).toBeLessThan(distance(weak))
    expect(distance(long)).toBeGreaterThan(100)
  })

  it("holds dragged nodes, releases them, and settles in a bounded number of steps", () => {
    const physics = new NoteGraphPhysics(["a", "b"], [{ source: "a", target: "b" }], 280)
    physics.pin("a", { x: 30, y: 40 })
    for (let i = 0; i < 20; i++) physics.step()
    expect(physics.positions().get("a")).toEqual({ x: 30, y: 40 })
    physics.release("a")
    let steps = 0
    while (physics.step() && steps < 500) steps++
    expect(steps).toBeLessThan(500)
    expect(physics.positions().get("a")).not.toEqual({ x: 30, y: 40 })
    expect(Number.isFinite(distance(physics))).toBe(true)
  })

  it("preserves existing positions and initializes only new nodes", () => {
    const physics = new NoteGraphPhysics(["a", "new"], [], 280,
      new Map([["a", { x: 12, y: 34 }], ["deleted", { x: 1, y: 2 }]]))
    expect(physics.positions().get("a")).toEqual({ x: 12, y: 34 })
    expect(physics.nodes.has("new")).toBe(true)
    expect(physics.nodes.has("deleted")).toBe(false)
  })
})
