import { RiEqualizerLine } from "@remixicon/react"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/tiptap-ui-primitive/popover"
import { GRAPH_FORCES } from "@/lib/note-graph-physics"

export type GraphDisplay = { nodeSize: number; lineThickness: number }
export const DEFAULT_GRAPH_DISPLAY: GraphDisplay = { nodeSize: 5, lineThickness: 1.5 }

function Slider({ label, value, min, max, step, onChange, decimals }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; decimals?: number
}) {
  return (
    <label className="graph-options__slider">
      <span>{label}<output>{decimals === undefined ? value : value.toFixed(decimals)}</output></span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
    </label>
  )
}

function ForceSlider({ label, value, baseline, onChange }: {
  label: string; value: number; baseline: number; onChange: (value: number) => void
}) {
  return <Slider label={label} value={Number((value / baseline).toFixed(1))} min={0} max={5} step={0.1} decimals={1} onChange={multiplier => onChange(multiplier * baseline)} />
}

export function GraphOptions({ display, forces, onDisplayChange, onForcesChange }: {
  display: GraphDisplay
  forces: typeof GRAPH_FORCES
  onDisplayChange: (display: GraphDisplay) => void
  onForcesChange: (forces: typeof GRAPH_FORCES) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="note-graph__options-button" data-style="ghost" type="button" aria-label="Graph options" tooltip="Graph options">
          <RiEqualizerLine className="tiptap-button-icon" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="graph-options" align="end" collisionPadding={12} aria-label="Graph options">
        <details open>
          <summary>Display</summary>
          <Slider label="Node size" value={display.nodeSize} min={2} max={12} step={0.5} onChange={nodeSize => onDisplayChange({ ...display, nodeSize })} />
          <Slider label="Line thickness" value={display.lineThickness} min={0.5} max={5} step={0.25} onChange={lineThickness => onDisplayChange({ ...display, lineThickness })} />
        </details>
        <details open>
          <summary>Forces</summary>
          <ForceSlider label="Center force" value={forces.centerForce} baseline={GRAPH_FORCES.centerForce} onChange={centerForce => onForcesChange({ ...forces, centerForce })} />
          <ForceSlider label="Repel force" value={forces.repelForce} baseline={GRAPH_FORCES.repelForce} onChange={repelForce => onForcesChange({ ...forces, repelForce })} />
          <ForceSlider label="Link force" value={forces.linkStrength} baseline={GRAPH_FORCES.linkStrength} onChange={linkStrength => onForcesChange({ ...forces, linkStrength })} />
          <Slider label="Link distance" value={forces.linkDistance} min={20} max={200} step={5} onChange={linkDistance => onForcesChange({ ...forces, linkDistance })} />
        </details>
        <button className="graph-options__reset" type="button" onClick={() => { onDisplayChange(DEFAULT_GRAPH_DISPLAY); onForcesChange(GRAPH_FORCES) }}>Reset to defaults</button>
      </PopoverContent>
    </Popover>
  )
}
