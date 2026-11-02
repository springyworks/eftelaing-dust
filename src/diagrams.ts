// maxGraph diagrams: the OSI+ (7+3) layer stack and the Maslow pyramid.

import {
  AbstractPathShape,
  Graph,
  InternalEvent,
  Point,
  ShapeRegistry,
  type AbstractCanvas2D,
  type Cell,
  type CellStyle,
  type TooltipHandler,
} from "@maxgraph/core";
import { LAYERS, MASLOW, NUM_LAYERS, clamp } from "./model";
import type { Simulation } from "./sim";

const SLOPE = 0.33;

class PyramidSliceShape extends AbstractPathShape {
  override redrawPath(c: AbstractCanvas2D, _x: number, _y: number, w: number, h: number): void {
    const inset = h * SLOPE;
    this.addPoints(c, [new Point(inset, 0), new Point(w - inset, 0), new Point(w, h), new Point(0, h)], false, 0, true);
  }
}
ShapeRegistry.add("pyramidSlice", PyramidSliceShape);

function makeGraph(container: HTMLElement): Graph {
  const g = new Graph(container);
  g.setCellsMovable(false);
  g.setCellsResizable(false);
  g.setCellsEditable(false);
  g.setCellsDisconnectable(false);
  g.setConnectable(false);
  g.setCellsSelectable(false);
  g.setHtmlLabels(true);
  g.setTooltips(true);
  return g;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

const GROUP_INFO = [
  { name: "Director", text: "Director: intent and meaning (L10)", from: 9, to: 9, color: "#b04ad0" },
  { name: "Players", text: "Players: agency and feeling (L8-L9)", from: 7, to: 8, color: "#d9a03a" },
  { name: "Instrument", text: "Instrument: the classic OSI stack (L1-L7)", from: 0, to: 6, color: "#4f96b5" },
] as const;

export class OsiDiagram {
  readonly graph: Graph;
  private readonly layerCells: Cell[] = [];
  private readonly edges: Cell[] = [];
  private selected = -1;

  constructor(container: HTMLElement, onSelect: (layer: number) => void) {
    this.graph = makeGraph(container);
    const g = this.graph;
    const parent = g.getDefaultParent();
    const W = 250;
    const H = 42;
    const GAP = 18;
    const X = 20;
    const top = 14;
    const yOf = (i: number): number => top + (NUM_LAYERS - 1 - i) * (H + GAP);

    g.batchUpdate(() => {
      for (const info of GROUP_INFO) {
        const y0 = yOf(info.to) - 6;
        const y1 = yOf(info.from) + H + 6;
        g.insertVertex({
          parent,
          value: info.text,
          position: [X + W + 24, y0],
          size: [140, y1 - y0],
          style: {
            shape: "rectangle",
            rounded: true,
            dashed: true,
            fillColor: "none",
            strokeColor: info.color,
            strokeWidth: 1.5,
            fontColor: info.color,
            fontSize: 12,
            whiteSpace: "wrap",
            verticalAlign: "middle",
          } satisfies CellStyle,
        });
      }

      LAYERS.forEach((info, i) => {
        const cell = g.insertVertex({
          parent,
          id: `L${info.id}`,
          value: "",
          position: [X, yOf(i)],
          size: [W, H],
          style: {
            rounded: true,
            arcSize: 18,
            fillColor: mix(info.color, "#101418", 0.7),
            strokeColor: info.color,
            strokeWidth: 2,
            fontColor: "#f1f1f1",
            fontSize: 13,
            whiteSpace: "wrap",
            shadow: false,
          } satisfies CellStyle,
        });
        this.layerCells.push(cell);
      });

      for (let i = 0; i < NUM_LAYERS - 1; i++) {
        const a = this.layerCells[i];
        const b = this.layerCells[i + 1];
        if (!a || !b) continue;
        this.edges.push(
          g.insertEdge({
            parent,
            source: a,
            target: b,
            style: { startArrow: "classic", endArrow: "classic", strokeColor: "#7d8794", strokeWidth: 2, endSize: 4, startSize: 4 } satisfies CellStyle,
          }),
        );
      }
    });

    g.addListener(InternalEvent.CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
      const cell = evt.getProperty("cell") as Cell | null | undefined;
      const idx = cell ? this.layerCells.indexOf(cell) : -1;
      if (idx >= 0) onSelect(idx);
    });
    const tooltip = (cell: Cell): string => {
      const idx = this.layerCells.indexOf(cell);
      const info = LAYERS[idx];
      return info ? `L${info.id} ${info.name}: ${info.role}. Click to select its ripple tank.` : "";
    };
    g.getPlugin<TooltipHandler>("TooltipHandler")!.getTooltipForCell = tooltip;
  }

  setSelected(layer: number): void {
    this.selected = layer;
  }

  update(sim: Simulation): void {
    const g = this.graph;
    g.batchUpdate(() => {
      LAYERS.forEach((info, i) => {
        const cell = this.layerCells[i];
        if (!cell) return;
        const rms = sim.rms[i] ?? 0;
        const stab = sim.stability[i] ?? 0;
        const level = clamp(rms / 0.35, 0, 1);
        g.getDataModel().setValue(
          cell,
          `<b>L${info.id} ${info.name}</b><br/><span style="font-size:10px;opacity:.8">amp ${rms.toFixed(2)} · stability ${(stab * 100).toFixed(0)}%</span>`,
        );
        g.setCellStyles("fillColor", mix(mix(info.color, "#101418", 0.85), info.color, level), [cell]);
        g.setCellStyles("strokeWidth", i === this.selected ? 4 : 2, [cell]);
        g.setCellStyles("strokeColor", i === this.selected ? "#ffffff" : info.color, [cell]);
      });
      this.edges.forEach((edge, i) => {
        const lock = sim.lock[i] ?? 0;
        g.setCellStyles("strokeWidth", 1 + lock * 3.5, [edge]);
        g.setCellStyles("strokeColor", mix("#4a5260", "#ffd34d", lock), [edge]);
      });
    });
  }
}

export class MaslowDiagram {
  readonly graph: Graph;
  private readonly cells: Cell[] = [];

  constructor(container: HTMLElement) {
    this.graph = makeGraph(container);
    const g = this.graph;
    const parent = g.getDefaultParent();
    const SLICE_H = 76;
    const BOTTOM_W = 440;
    const X = 20;
    const top = 16;

    g.batchUpdate(() => {
      MASLOW.forEach((level, m) => {
        const w = BOTTOM_W - 2 * m * SLICE_H * SLOPE;
        const y = top + (MASLOW.length - 1 - m) * (SLICE_H + 3);
        const cell = g.insertVertex({
          parent,
          id: `M${m}`,
          value: level.name,
          position: [X + (BOTTOM_W - w) / 2, y],
          size: [w, SLICE_H],
          style: {
            shape: "pyramidSlice",
            fillColor: mix(level.color, "#101418", 0.8),
            strokeColor: level.color,
            strokeWidth: 2,
            fontColor: "#f1f1f1",
            fontSize: 13,
            whiteSpace: "wrap",
          } satisfies CellStyle,
        });
        this.cells.push(cell);
      });
    });

    const tips = g.getPlugin<TooltipHandler>("TooltipHandler");
    if (tips) tips.getTooltipForCell = (cell: Cell): string => {
      const m = this.cells.indexOf(cell);
      const level = MASLOW[m];
      if (!level) return "";
      const ls = level.layers.map((l) => `L${l + 1}`).join(", ");
      return `${level.name} is fed by OSI+ layers ${ls}. Fulfilment = layer vitality x stability of the layers below. Upper levels dim when lower ones are unmet.`;
    };
  }

  update(sim: Simulation): void {
    const g = this.graph;
    g.batchUpdate(() => {
      MASLOW.forEach((level, m) => {
        const cell = this.cells[m];
        if (!cell) return;
        const f = sim.fulfilment[m] ?? 0;
        const avail = sim.availability[m] ?? 1;
        const ls = level.layers.length > 1 ? `L${level.layers[0]! + 1}-${level.layers[level.layers.length - 1]! + 1}` : `L${level.layers[0]! + 1}`;
        g.getDataModel().setValue(
          cell,
          `<b>${level.name}</b><br/><span style="font-size:10px;opacity:.85">${ls} · fulfilment ${(f * 100).toFixed(0)}%</span>`,
        );
        g.setCellStyles("fillColor", mix(mix(level.color, "#101418", 0.85), level.color, clamp(f, 0, 1)), [cell]);
        g.setCellStyles("opacity", Math.round(35 + 65 * avail), [cell]);
        g.setCellStyles("textOpacity", Math.round(50 + 50 * avail), [cell]);
      });
    });
  }
}
