// 3D view of the whole brain: the ten tanks as plates in a stack, with the links between them. Canvas 2D with an orthographic
// projection: a plane seen in parallel projection is an affine map, so each plate is just a field image drawn with setTransform.
//
// Everything drawn means something (nothing is decoration):
//   plate image        the wave field u of that layer (middle slice in 3D), brightness = displacement
//   plate rim          thickness = the layer's rms amplitude, white = the selected layer
//   vertical lines     the link between two layers at a sample of cells: brightness and width = coupling (sand memory, 1 =
//                      innate) x how in-phase the two layers have recently been there
//   moving dots        run along a link from the louder to the quieter layer, faster for a bigger difference
// Drag to orbit, wheel to zoom, tap a plate to select that layer and tickle it at that spot.

import { LAYERS, NUM_LAYERS } from "./model";
import type { Simulation, Vec3 } from "./sim";

const GAP = 0.3; // vertical distance between plates, in plate half-widths
const LATTICE = 7; // links sampled per side
const BG: readonly [number, number, number] = [10, 14, 22];

const RGB = LAYERS.map((l): [number, number, number] => {
  const n = parseInt(l.color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

interface Pt {
  x: number;
  y: number;
}

export class Stack3D {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly field = document.createElement("canvas");
  private readonly fctx: CanvasRenderingContext2D;
  yaw = 0.6;
  pitch = 0.75;
  zoom = 1;
  private dragging = false;
  private moved = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onTap: (layer: number, pos: Vec3) => void,
  ) {
    const c = canvas.getContext("2d");
    const f = this.field.getContext("2d");
    if (!c || !f) throw new Error("2D canvas unavailable");
    this.ctx = c;
    this.fctx = f;
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.moved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.yaw += dx * 0.01;
      this.pitch = Math.min(1.5, Math.max(0.12, this.pitch + dy * 0.008));
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.moved < 5) this.tap(e);
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(2.6, Math.max(0.5, this.zoom * Math.exp(-e.deltaY * 0.001)));
      },
      { passive: false },
    );
  }

  setView(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.zoom = 1;
  }

  private nx = 1;
  private ny = 1;

  /** Plate corner (u, v in 0..1) of layer l on the screen. */
  private project(l: number, u: number, v: number, aspect: number): Pt {
    const sc = this.scale();
    const X = (u * 2 - 1) * 1;
    const Y = (v * 2 - 1) * aspect;
    const Z = (l - (NUM_LAYERS - 1) / 2) * GAP;
    const ca = Math.cos(this.yaw);
    const sa = Math.sin(this.yaw);
    const X1 = X * ca - Y * sa;
    const Y1 = X * sa + Y * ca;
    const cb = Math.cos(this.pitch);
    const sb = Math.sin(this.pitch);
    return { x: this.canvas.width / 2 + X1 * sc, y: this.canvas.height / 2 - (Y1 * sb + Z * cb) * sc };
  }

  private scale(): number {
    return this.zoom * Math.min(this.canvas.height / 3.9, this.canvas.width / 3.3);
  }

  private aspect(): number {
    return Math.max(0.12, Math.min(1, this.ny / this.nx));
  }

  private tap(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const a = this.aspect();
    for (let l = NUM_LAYERS - 1; l >= 0; l--) {
      const p0 = this.project(l, 0, 0, a);
      const p1 = this.project(l, 1, 0, a);
      const p2 = this.project(l, 0, 1, a);
      const ax = p1.x - p0.x;
      const ay = p1.y - p0.y;
      const bx = p2.x - p0.x;
      const by = p2.y - p0.y;
      const det = ax * by - ay * bx;
      if (Math.abs(det) < 1e-6) continue;
      const u = ((x - p0.x) * by - (y - p0.y) * bx) / det;
      const v = ((y - p0.y) * ax - (x - p0.x) * ay) / det;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        this.onTap(l, [u, v, 0.5]);
        return;
      }
    }
  }

  draw(sim: Simulation, selected: number, time: number): void {
    const { ctx, canvas } = this;
    this.nx = sim.nx;
    this.ny = sim.ny;
    const aspect = this.aspect();
    const plane = sim.nx * sim.ny;
    const zMid = Math.floor(sim.nz / 2) * plane;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#090d13";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.field.width !== sim.nx || this.field.height !== sim.ny) {
      this.field.width = sim.nx;
      this.field.height = sim.ny;
    }
    const img = this.fctx.createImageData(sim.nx, sim.ny);
    const sc = this.scale();

    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = sim.u[l];
      const col = RGB[l] ?? [128, 128, 128];
      if (!u) continue;
      for (let i = 0; i < plane; i++) {
        const v = Math.max(-1, Math.min(1, (u[zMid + i] ?? 0) * 2.2));
        const b = 0.22 + 0.78 * (0.5 + 0.5 * v);
        const o = i * 4;
        img.data[o] = BG[0] + (col[0] * 1.15 - BG[0]) * b;
        img.data[o + 1] = BG[1] + (col[1] * 1.15 - BG[1]) * b;
        img.data[o + 2] = BG[2] + (col[2] * 1.15 - BG[2]) * b;
        img.data[o + 3] = 255;
      }
      this.fctx.putImageData(img, 0, 0);
      const p0 = this.project(l, 0, 0, aspect);
      const p1 = this.project(l, 1, 0, aspect);
      const p2 = this.project(l, 0, 1, aspect);
      ctx.save();
      ctx.globalAlpha = 0.82;
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform((p1.x - p0.x) / sim.nx, (p1.y - p0.y) / sim.nx, (p2.x - p0.x) / sim.ny, (p2.y - p0.y) / sim.ny, p0.x, p0.y);
      ctx.drawImage(this.field, 0, 0);
      ctx.restore();

      // rim: thickness = amplitude, white = selected
      const p3 = this.project(l, 1, 1, aspect);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.lineWidth = 1 + Math.min(5, Math.sqrt(sim.rms[l] ?? 0) * 7);
      ctx.strokeStyle = l === selected ? "#ffffff" : `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.stroke();
      ctx.fillStyle = l === selected ? "#ffffff" : "#9fb0c8";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(`L${l + 1}`, p1.x + 6, p1.y + 4);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let l = 0; l < NUM_LAYERS - 1; l++) this.links(sim, l, aspect, time, sc);
  }

  private links(sim: Simulation, l: number, aspect: number, time: number, sc: number): void {
    const { ctx } = this;
    const cpl = sim.couplingMap(l);
    const coh = sim.coherenceMap(l);
    if (!cpl || !coh) return;
    const down = (sim.rms[l + 1] ?? 0) > (sim.rms[l] ?? 0); // dots run from the louder layer to the quieter one
    const speed = 0.25 + Math.min(2.5, Math.abs((sim.rms[l + 1] ?? 0) - (sim.rms[l] ?? 0)) * 18);
    const col = RGB[l + 1] ?? [200, 200, 200];
    const cols = sim.ny === 1 ? 24 : LATTICE;
    const rows = sim.ny === 1 ? 1 : LATTICE;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const u = (gx + 0.5) / cols;
        const v = rows === 1 ? 0.5 : (gy + 0.5) / rows;
        const i = Math.min(sim.ny - 1, Math.floor(v * sim.ny)) * sim.nx + Math.min(sim.nx - 1, Math.floor(u * sim.nx));
        const c = cpl[i] ?? 1;
        const s = Math.max(0, Math.min(1, Math.max(0, coh[i] ?? 0) * c * 2));
        const a = this.project(l, u, v, aspect);
        const b = this.project(l + 1, u, v, aspect);
        ctx.strokeStyle = `rgba(${col[0] + 40},${col[1] + 40},${col[2] + 40},${0.04 + 0.12 * Math.min(1.5, c) / 1.5 + 0.55 * s * s})`;
        ctx.lineWidth = 0.5 + 2 * s * s;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (s > 0.3) {
          const ph = (time * speed + (gx * 0.37 + gy * 0.61 + l * 0.17)) % 1;
          const f = down ? 1 - ph : ph;
          ctx.fillStyle = `rgba(255,240,200,${0.4 + 0.6 * s})`;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, Math.max(1.2, (1 + 2.2 * s) * (sc / 120)), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}
