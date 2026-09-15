import { Table as TiptapTable, TableKit } from "@tiptap/extension-table"
import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { TableMap } from "@tiptap/pm/tables"
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view"

// Narrowest a column is squeezed to when another column needs the room.
const MIN_COLUMN_PX = 64

// Finds the level `t` at which `sum(combine(demand, t))` fills `available`.
function solveLevel(demands: number[], available: number, combine: (d: number, t: number) => number, hi: number) {
  let lo = 0
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const total = demands.reduce((sum, d) => sum + combine(d, mid), 0)
    if (total < available) lo = mid
    else hi = mid
  }
  return hi
}

/**
 * Splits `available` px between columns whose unwrapped content needs
 * `demands` px. Columns stay equal until one needs more than its share:
 * - If everything fits, columns that need more get exactly what they need
 *   and the rest share the remaining space equally.
 * - If not, columns that fit keep their natural width and the ones that
 *   don't split what's left equally (and wrap).
 */
export function allocateColumnWidths(demands: number[], available: number): number[] {
  const n = demands.length
  if (n === 0) return []
  if (available <= 0) return Array(n).fill(available / n)

  const needs = demands.map((d) => Math.max(d, MIN_COLUMN_PX))
  const totalNeed = needs.reduce((sum, d) => sum + d, 0)

  if (totalNeed <= available) {
    const t = solveLevel(needs, available, Math.max, available)
    return needs.map((d) => Math.max(d, t))
  }
  const t = solveLevel(needs, available, Math.min, Math.max(...needs))
  return needs.map((d) => Math.min(d, t))
}

class AutoWidthTableView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private table: HTMLTableElement
  private colgroup: HTMLTableColElement
  // Hidden scratch area where cell copies are laid out unwrapped to measure
  // how wide each column's content wants to be.
  private measure: HTMLElement
  private node: PMNode
  private view: EditorView
  private getPos: () => number | undefined
  private frame: number | null = null
  private resizeObserver: ResizeObserver | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement("div")
    this.dom.className = "tableWrapper"
    this.table = this.dom.appendChild(document.createElement("table"))
    this.colgroup = this.table.appendChild(document.createElement("colgroup"))
    this.contentDOM = this.table.appendChild(document.createElement("tbody"))
    this.measure = this.dom.appendChild(document.createElement("div"))
    this.measure.className = "table-measure"
    this.measure.contentEditable = "false"
    this.measure.setAttribute("aria-hidden", "true")

    this.setColumnWidths(Array(TableMap.get(node).width).fill(1))

    if (typeof ResizeObserver !== "undefined") {
      let lastWidth = -1
      this.resizeObserver = new ResizeObserver(() => {
        if (this.dom.clientWidth === lastWidth) return
        lastWidth = this.dom.clientWidth
        this.scheduleLayout()
      })
      this.resizeObserver.observe(this.dom)
    }
    this.scheduleLayout()
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    // Children's DOM is updated after this returns, so measure next frame.
    this.scheduleLayout()
    return true
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
  }

  // Column widths and the measuring area are ours, not content edits
  // ProseMirror should re-read.
  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === "selection") return false
    return (
      this.colgroup.contains(mutation.target) ||
      this.measure.contains(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === this.table)
    )
  }

  private scheduleLayout() {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.layout()
    })
  }

  private layout() {
    const available = this.dom.clientWidth
    const tablePos = this.getPos()
    const map = TableMap.get(this.node)
    if (!available || tablePos === undefined) {
      this.setColumnWidths(Array(map.width).fill(1))
      return
    }

    const demands = this.measureColumns(map, tablePos + 1)
    this.setColumnWidths(allocateColumnWidths(demands, available))
  }

  private measureColumns(map: TableMap, tableStart: number): number[] {
    // One single-column table per grid column (plus one per merged cell), so
    // each table's max-content width is that column's unwrapped width.
    const columnBodies = Array.from({ length: map.width }, () => this.addMeasureTable())
    const merged: { body: HTMLElement; left: number; right: number }[] = []
    const seen = new Set<number>()

    for (const cellPos of map.map) {
      if (seen.has(cellPos)) continue
      seen.add(cellPos)

      const cellDOM = this.view.nodeDOM(tableStart + cellPos)
      if (!(cellDOM instanceof HTMLElement)) continue
      const clone = cellDOM.cloneNode(true) as HTMLElement
      clone.removeAttribute("colspan")
      clone.removeAttribute("rowspan")
      clone.classList.remove("selectedCell")
      const row = document.createElement("tr")
      row.appendChild(clone)

      const { left, right } = map.findCell(cellPos)
      if (right - left === 1) {
        columnBodies[left].appendChild(row)
      } else {
        const body = this.addMeasureTable()
        body.appendChild(row)
        merged.push({ body, left, right })
      }
    }

    // +1 absorbs sub-pixel rounding so text that just fits doesn't wrap.
    const widthOf = (body: HTMLElement) => Math.ceil(body.parentElement!.getBoundingClientRect().width) + 1
    const demands = columnBodies.map((body) => (body.childElementCount ? widthOf(body) : 0))
    for (const { body, left, right } of merged) {
      const perColumn = widthOf(body) / (right - left)
      for (let col = left; col < right; col++) demands[col] = Math.max(demands[col], perColumn)
    }

    this.measure.replaceChildren()
    return demands
  }

  private addMeasureTable() {
    const table = this.measure.appendChild(document.createElement("table"))
    return table.appendChild(document.createElement("tbody"))
  }

  private setColumnWidths(widths: number[]) {
    const total = widths.reduce((sum, w) => sum + w, 0) || 1

    while (this.colgroup.children.length > widths.length) {
      this.colgroup.lastElementChild!.remove()
    }
    widths.forEach((w, i) => {
      const col =
        (this.colgroup.children[i] as HTMLTableColElement | undefined) ??
        this.colgroup.appendChild(document.createElement("col"))
      // Number() drops trailing zeros so this matches the browser-normalized value.
      const width = `${Number(((w / total) * 100).toFixed(3))}%`
      if (col.style.width !== width) col.style.width = width
    })
  }
}

const AutoWidthTable = TiptapTable.extend({
  addNodeView() {
    return ({ node, view, getPos }) => new AutoWidthTableView(node, view, getPos)
  },
})

// Tables span the text width, with columns sized from their content (see
// `allocateColumnWidths`). Column resizing by dragging is left off.
export const Table = Extension.create({
  name: "tableNodes",

  addExtensions() {
    return [
      TableKit.configure({ table: false }),
      AutoWidthTable.configure({ allowTableNodeSelection: true }),
    ]
  },
})

export default Table
