// Canvas rendering of the layer wave fields.

import type { Projection } from "./model";
import type { Simulation } from "./sim";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const BG: [number, number, number] = [9, 13, 19];
const SAND_DARK: [number, number, number] = [86, 62, 36];
const SAND_LIGHT: [number, number, number] = [238, 208, 146];

function sandColor(t: number, shade: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ch = (i: number): number =>
    Math.max(0, Math.min(255, Math.round(((SAND_DARK[i] ?? 0) + ((SAND_LIGHT[i] ?? 0) - (SAND_DARK[i] ?? 0)) * k) * shade)));
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

export class TankView {
  private readonly pos: [number, number, number];
  private readonly neg: [number, number, number];
  private image: ImageData | null = null;
  private off: HTMLCanvasElement | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly layer: number,
    color: string,
    private readonly large: boolean,
  ) {
    const [r, g, b] = hexToRgb(color);
    this.pos = [Math.min(255, r + 70), Math.min(255, g + 70), Math.min(255, b + 70)];
    this.neg = [255 - r, 255 - g, 255 - b];
  }

  // Resizes backing store for the current dimensionality.
  configure(sim: Simulation): void {
    const { nx, ny, dim } = sim;
    this.image = null;
    this.off = null;
    if (this.large) {
      this.canvas.width = 560;
      this.canvas.height = dim === 1 ? 200 : 560;
    } else {
      this.canvas.width = dim === 1 ? 96 : nx;
      this.canvas.height = dim === 1 ? 32 : ny;
    }
  }

  // Maps a pointer position (fractions of the canvas) back to a tank position for the given projection.
  pick(fx: number, fy: number, projection: Projection): [number, number, number] {
    const c = (v: number): number => Math.max(0, Math.min(1, v));
    if (this.large && projection === "iso") {
      const depth = c((fy - 0.36) / 0.48);
      return [c((fx - (0.2 * (1 - depth) + 0.03)) / 0.74), depth, 0.5];
    }
    if (this.large && projection === "profile") return [c(fx), 0.5, 0.5];
    return [c(fx), c(fy), 0.5];
  }

  draw(sim: Simulation, gain: number, projection: Projection = "wave"): void {
    const ctx2d = this.canvas.getContext("2d");
    const field = sim.u[this.layer];
    const bed = sim.bed[this.layer];
    if (!ctx2d || !field || !bed) return;
    // Thumbnails are too small for the 3D-ish projections.
    const mode: Projection = !this.large && (projection === "iso" || projection === "profile") ? "both" : projection;
    if (sim.dim === 1) {
      if (mode === "wave") this.drawLine(ctx2d, sim, field, gain);
      else this.drawProfile(ctx2d, sim, field, bed, gain);
    } else if (mode === "iso") this.drawIso(ctx2d, sim, field, bed, gain);
    else if (mode === "profile") this.drawProfile(ctx2d, sim, field, bed, gain);
    else this.drawImage(ctx2d, sim, field, bed, gain, mode);
  }

  private drawLine(c: CanvasRenderingContext2D, sim: Simulation, f: Float32Array, gain: number): void {
    const { width: w, height: h } = this.canvas;
    c.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = `rgb(${this.pos.join(",")})`;
    c.lineWidth = this.large ? 2 : 1;
    c.beginPath();
    for (let x = 0; x < sim.nx; x++) {
      const px = (x / (sim.nx - 1)) * w;
      const py = h / 2 - Math.max(-1, Math.min(1, (f[x] ?? 0) * gain)) * (h / 2 - 2);
      if (x === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  }

  // Isometric-like projection: rows of the tank drawn back to front, sand surface solid, water as a translucent sheet on top.
  private drawIso(c: CanvasRenderingContext2D, sim: Simulation, f: Float32Array, bed: Float32Array, gain: number): void {
    const { width: w, height: h } = this.canvas;
    const { nx, ny, nz } = sim;
    c.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
    c.fillRect(0, 0, w, h);
    const mean = sim.sandMass(this.layer) / sim.plane;
    const zOff = nz > 1 ? Math.floor(nz / 2) * nx * ny : 0;
    const top = h * 0.36;
    const bottom = h * 0.84;
    const span = w * 0.74;
    const shear = w * 0.2;
    const sandPx = h * 0.3;
    const wavePx = h * 0.08;
    const sandY: number[] = new Array(nx);
    const waterY: number[] = new Array(nx);
    const sx: number[] = new Array(nx);
    for (let y = 0; y < ny; y++) {
      const depth = y / (ny - 1);
      const yy = top + (bottom - top) * depth;
      const x0 = shear * (1 - depth) + w * 0.03;
      for (let x = 0; x < nx; x++) {
        const i = x + y * nx;
        sx[x] = x0 + (x / (nx - 1)) * span;
        const sh = ((bed[i] ?? 0) - mean) * sandPx;
        sandY[x] = yy - sh;
        const wv = Math.max(-1.2, Math.min(1.2, (f[zOff + i] ?? 0) * gain)) * wavePx;
        waterY[x] = Math.min((sandY[x] ?? 0) - 1, yy - sh - 7 - wv);
      }
      const front = 0.7 + 0.3 * depth;
      // Sand: one quad per column, coloured by height and lit from the left by the local slope.
      for (let x = 0; x < nx - 1; x++) {
        const x1 = sx[x + 1] ?? 0;
        const y0 = sandY[x] ?? 0;
        const y1 = sandY[x + 1] ?? 0;
        const hgt = ((bed[x + y * nx] ?? 0) - mean) * 1.5 + 0.5;
        c.fillStyle = sandColor(hgt, front * Math.max(0.6, Math.min(1.4, 1 + (y0 - y1) * 0.12)));
        c.beginPath();
        c.moveTo(sx[x] ?? 0, y0);
        c.lineTo(x1 + 0.7, y1);
        c.lineTo(x1 + 0.7, yy + 16);
        c.lineTo(sx[x] ?? 0, yy + 16);
        c.closePath();
        c.fill();
      }
      c.beginPath();
      c.moveTo(sx[0] ?? 0, waterY[0] ?? 0);
      for (let x = 1; x < nx; x++) c.lineTo(sx[x] ?? 0, waterY[x] ?? 0);
      for (let x = nx - 1; x >= 0; x--) c.lineTo(sx[x] ?? 0, sandY[x] ?? 0);
      c.closePath();
      c.fillStyle = `rgba(${this.pos[0]},${this.pos[1]},${this.pos[2]},0.28)`;
      c.fill();
      c.beginPath();
      c.moveTo(sx[0] ?? 0, waterY[0] ?? 0);
      for (let x = 1; x < nx; x++) c.lineTo(sx[x] ?? 0, waterY[x] ?? 0);
      c.strokeStyle = `rgba(${this.pos[0]},${this.pos[1]},${this.pos[2]},${0.35 + 0.6 * depth})`;
      c.lineWidth = 1;
      c.stroke();
    }
  }

  // Side cross-section like a beach profile: sand averaged over y, water surface along the middle row.
  private drawProfile(c: CanvasRenderingContext2D, sim: Simulation, f: Float32Array, bed: Float32Array, gain: number): void {
    const { width: w, height: h } = this.canvas;
    const { nx, ny, nz } = sim;
    c.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
    c.fillRect(0, 0, w, h);
    const mean = sim.sandMass(this.layer) / sim.plane;
    const level = h * (sim.dim === 1 ? 0.42 : 0.4);
    const sandBase = h * (sim.dim === 1 ? 0.74 : 0.7);
    const sandPx = h * 1.2;
    const wavePx = h * (sim.dim === 1 ? 0.3 : 0.12);
    const midRow = ny > 1 ? Math.floor(ny / 2) : 0;
    const zOff = nz > 1 ? Math.floor(nz / 2) * nx * ny : 0;
    const sand: number[] = [];
    const water: number[] = [];
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let y = 0; y < ny; y++) acc += bed[x + y * nx] ?? 0;
      const sy = sandBase - (acc / ny - mean) * sandPx;
      sand.push(sy);
      const wv = Math.max(-1.3, Math.min(1.3, (f[zOff + x + midRow * nx] ?? 0) * gain)) * wavePx;
      water.push(Math.min(sy - 1, level - wv));
    }
    const px = (x: number): number => (x / (nx - 1)) * w;
    c.strokeStyle = "#2a3342";
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(0, sandBase);
    c.lineTo(w, sandBase);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(px(0), water[0] ?? 0);
    for (let x = 1; x < nx; x++) c.lineTo(px(x), water[x] ?? 0);
    for (let x = nx - 1; x >= 0; x--) c.lineTo(px(x), sand[x] ?? 0);
    c.closePath();
    c.fillStyle = `rgba(${this.pos[0]},${this.pos[1]},${this.pos[2]},0.3)`;
    c.fill();
    c.beginPath();
    c.moveTo(px(0), sand[0] ?? 0);
    for (let x = 1; x < nx; x++) c.lineTo(px(x), sand[x] ?? 0);
    c.lineTo(w, h);
    c.lineTo(0, h);
    c.closePath();
    c.fillStyle = sandColor(0.7, 0.95);
    c.fill();
    c.strokeStyle = sandColor(1, 1.1);
    c.lineWidth = this.large ? 2 : 1;
    c.stroke();
    c.beginPath();
    c.moveTo(px(0), water[0] ?? 0);
    for (let x = 1; x < nx; x++) c.lineTo(px(x), water[x] ?? 0);
    c.strokeStyle = `rgb(${this.pos.join(",")})`;
    c.stroke();
  }

  private drawImage(c: CanvasRenderingContext2D, sim: Simulation, f: Float32Array, bed: Float32Array, gain: number, mode: Projection): void {
    const { nx, ny, nz } = sim;
    if (!this.image || this.image.width !== nx || this.image.height !== ny) this.image = new ImageData(nx, ny);
    const data = this.image.data;
    const zOff = nz > 1 ? Math.floor(nz / 2) * nx * ny : 0;
    const showSand = mode !== "wave";
    const mean = showSand ? sim.sandMass(this.layer) / sim.plane : 0;
    const water = mode === "sand" ? 0 : mode === "both" ? 0.4 : 1;
    for (let i = 0; i < nx * ny; i++) {
      const v = Math.max(-1, Math.min(1, (f[zOff + i] ?? 0) * gain));
      const col = v >= 0 ? this.pos : this.neg;
      const a = Math.min(1, Math.abs(v));
      const o = i * 4;
      let r: number = BG[0];
      let g: number = BG[1];
      let b: number = BG[2];
      if (showSand) {
        const x = i % nx;
        const y = (i / nx) | 0;
        const bx = (bed[x < nx - 1 ? i + 1 : i] ?? 0) - (bed[x > 0 ? i - 1 : i] ?? 0);
        const by = ny > 1 ? (bed[y < ny - 1 ? i + nx : i] ?? 0) - (bed[y > 0 ? i - nx : i] ?? 0) : 0;
        const shade = Math.max(0.4, Math.min(1.6, 1 - 9 * (bx + by)));
        const t = 0.5 + ((bed[i] ?? 0) - mean) * 1.6;
        const k = Math.max(0, Math.min(1, t));
        r = Math.min(255, ((SAND_DARK[0] ?? 0) + ((SAND_LIGHT[0] ?? 0) - (SAND_DARK[0] ?? 0)) * k) * shade);
        g = Math.min(255, ((SAND_DARK[1] ?? 0) + ((SAND_LIGHT[1] ?? 0) - (SAND_DARK[1] ?? 0)) * k) * shade);
        b = Math.min(255, ((SAND_DARK[2] ?? 0) + ((SAND_LIGHT[2] ?? 0) - (SAND_DARK[2] ?? 0)) * k) * shade);
      }
      const wa = showSand ? a * water : a;
      data[o] = r + (col[0] - r) * wa;
      data[o + 1] = g + (col[1] - g) * wa;
      data[o + 2] = b + (col[2] - b) * wa;
      data[o + 3] = 255;
    }
    if (!this.large) {
      c.putImageData(this.image, 0, 0);
      return;
    }
    if (!this.off) {
      this.off = document.createElement("canvas");
      this.off.width = nx;
      this.off.height = ny;
    }
    this.off.getContext("2d")?.putImageData(this.image, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.off, 0, 0, this.canvas.width, this.canvas.height);
  }
}

export class Scope {
  private readonly history: Float32Array[] = [];
  private readonly capacity = 300;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly colors: readonly string[],
  ) {}

  push(values: Float32Array): void {
    this.history.push(Float32Array.from(values));
    if (this.history.length > this.capacity) this.history.shift();
  }

  draw(): void {
    const c = this.canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = this.canvas;
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#1d2530";
    c.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      c.beginPath();
      c.moveTo(0, (h * k) / 4);
      c.lineTo(w, (h * k) / 4);
      c.stroke();
    }
    this.colors.forEach((col, l) => {
      c.strokeStyle = col;
      c.lineWidth = 1.5;
      c.beginPath();
      this.history.forEach((s, i) => {
        const x = (i / (this.capacity - 1)) * w;
        const y = h - Math.min(1, (s[l] ?? 0) / 0.6) * (h - 4) - 2;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.stroke();
    });
  }
}
