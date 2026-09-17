import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import * as Y from "yjs"
import { ensureNoteLinks } from "@/lib/yjs-utils"
import { getNoteLinkIndex, NoteLinkTracker } from "@/lib/note-link-index"
import { NoteGraph } from "./note-graph"

vi.mock("@/lib/yjs-utils", () => ({ ensureNoteLinks: vi.fn(async () => {}) }))

it("updates connections from documents, navigates, renames, and removes observers", async () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  const index = getNoteLinkIndex("nb")
  await index.idb.whenSynced
  const trackers = [new NoteLinkTracker(a, targets => index.links.set("a", targets)), new NoteLinkTracker(b, targets => index.links.set("b", targets))]
  const unobserve = vi.spyOn(index.links, "unobserve")
  const onNavigate = vi.fn()
  const tree = { id: "root", name: "Notebook", isFolder: true, children: [
    { id: "a", name: "Alpha", isFolder: false },
    { id: "b", name: "Beta", isFolder: false },
    { id: "image", name: "Photo", isFolder: false, assetId: "asset" },
  ] }
  const { rerender, unmount } = render(<NoteGraph notebookId="nb" tree={tree} currentNoteId="a" onNavigate={onNavigate} />)
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  const graph = screen.getByLabelText("Note connections")
  expect(graph.querySelectorAll("line")).toHaveLength(0)
  expect(screen.queryByRole("button", { name: "Zoom in" })).not.toBeInTheDocument()
  const wheel = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })
  act(() => graph.dispatchEvent(wheel))
  expect(wheel.defaultPrevented).toBe(true)
  expect(parseFloat(graph.style.width)).toBeGreaterThan(100)
  fireEvent.wheel(graph, { deltaY: -10000 })
  expect(graph.style.width).toBe("400%")
  fireEvent.wheel(graph, { deltaY: 10000 })
  expect(graph.style.width).toBe("25%")
  fireEvent.wheel(graph, { deltaY: -Math.log(4) / 0.002 })
  expect(graph.style.width).toBe("100%")
  const canvas = graph.parentElement!
  canvas.setPointerCapture = vi.fn()
  canvas.hasPointerCapture = vi.fn(() => true)
  canvas.releasePointerCapture = vi.fn()
  const pointer = (type: string, clientX: number, clientY: number, target: Element = canvas, button = 0) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX, clientY })
    Object.defineProperty(event, "pointerId", { value: 1 })
    fireEvent(target, event)
  }
  pointer("pointerdown", 100, 100)
  pointer("pointermove", 140, 125)
  expect(graph.style.transform).toBe("translate(40px, 25px)")
  expect(canvas).toHaveClass("is-dragging")
  pointer("pointerup", 140, 125)
  expect(canvas).not.toHaveClass("is-dragging")
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(1)
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }), { detail: 1 })
  expect(onNavigate).not.toHaveBeenCalled()
  pointer("pointerdown", 140, 125)
  pointer("pointerup", 140, 125)
  act(() => {
    const link = new Y.XmlElement("noteLink")
    link.setAttribute("noteId", "b")
    a.getXmlFragment("default").insert(0, [link])
  })
  expect(graph.querySelectorAll("line")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }), { detail: 1 })
  expect(onNavigate).toHaveBeenLastCalledWith("b")
  fireEvent.keyDown(screen.getByRole("button", { name: "Open Alpha" }), { key: "Enter" })
  expect(onNavigate).toHaveBeenLastCalledWith("a")
  rerender(<NoteGraph notebookId="nb" tree={{ ...tree, children: tree.children.map(node => node.id === "b" ? { ...node, name: "Renamed" } : node) }} currentNoteId="a" onNavigate={onNavigate} />)
  expect(screen.getByRole("button", { name: "Open Renamed" })).toBeInTheDocument()
  const alpha = screen.getByRole("button", { name: "Open Alpha" })
  const originalPosition = alpha.getAttribute("transform")
  pointer("pointerdown", 100, 100, alpha)
  pointer("pointermove", 180, 150)
  await waitFor(() => expect(alpha.getAttribute("transform")).not.toBe(originalPosition))
  expect(graph.style.transform).toBe("translate(40px, 25px)")
  pointer("pointerup", 180, 150)
  onNavigate.mockClear()
  fireEvent.click(alpha, { detail: 1 })
  expect(onNavigate).not.toHaveBeenCalled()
  // Middle dragging pans even when it starts on a note.
  pointer("pointerdown", 100, 100, alpha, 1)
  pointer("pointermove", 130, 120, canvas, 1)
  expect(graph.style.transform).toBe("translate(70px, 45px)")
  pointer("pointerup", 130, 120, canvas, 1)
  expect(canvas).not.toHaveClass("is-dragging")

  // Cursor anchoring also accounts for app-level CSS zoom and existing pan.
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 30, top: 50, width: 400, height: 800 } as DOMRect)
  Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 200 })
  fireEvent.wheel(graph, { deltaY: -100, clientX: 230, clientY: 350 })
  const ratio = Math.exp(0.2)
  const translation = graph.style.transform.match(/translate\((.*)px, (.*)px\)/)!
  expect(Number(translation[1])).toBeCloseTo(100 - (100 - 70) * ratio)
  expect(Number(translation[2])).toBeCloseTo(150 - (150 - 45) * ratio)
  expect(graph.style.height).toBe(graph.style.width)
  fireEvent.wheel(graph, { deltaY: 100, clientX: 230, clientY: 350 })
  const restored = graph.style.transform.match(/translate\((.*)px, (.*)px\)/)!
  expect(Number(restored[1])).toBeCloseTo(70)
  expect(Number(restored[2])).toBeCloseTo(45)
  fireEvent.click(screen.getByRole("button", { name: "Graph options" }))
  expect(screen.getByRole("dialog", { name: "Graph options" })).toBeInTheDocument()
  fireEvent.change(screen.getByRole("slider", { name: "Node size" }), { target: { value: "8" } })
  expect(alpha.querySelector("circle")).toHaveAttribute("r", "8")
  fireEvent.change(screen.getByRole("slider", { name: "Line thickness" }), { target: { value: "3" } })
  expect(graph.querySelector("line")!.style.strokeWidth).toBe("3")
  for (const [name, value] of [["Center force", "2"], ["Repel force", "1.5"], ["Link force", "0.5"], ["Link distance", "100"]]) {
    const slider = screen.getByRole("slider", { name })
    fireEvent.change(slider, { target: { value } })
    expect(slider).toHaveValue(value)
  }
  fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }))
  expect(alpha.querySelector("circle")).toHaveAttribute("r", "5")
  expect(graph.querySelector("line")!.style.strokeWidth).toBe("1.5")
  for (const name of ["Center force", "Repel force", "Link force"]) {
    const slider = screen.getByRole("slider", { name })
    expect(slider).toHaveValue("1")
    expect(slider.closest("label")!.querySelector("output")).toHaveTextContent("1.0")
  }
  expect(screen.getByRole("slider", { name: "Link distance" })).toHaveValue("65")
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Graph options" }), { key: "Escape" })
  act(() => a.getXmlFragment("default").delete(0, 1))
  expect(graph.querySelectorAll("line")).toHaveLength(0)
  unmount()
  expect(unobserve).toHaveBeenCalledOnce()
  expect(ensureNoteLinks).toHaveBeenCalled()
  trackers.forEach(tracker => tracker.destroy())
  a.destroy()
  b.destroy()
})
