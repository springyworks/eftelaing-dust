// Canvas rendering of the layer wave fields.

import type { Simulation } from "./sim";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const BG: [number, number, number] = [9, 13, 19];

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

  draw(sim: Simulation, gain: number): void {
    const ctx2d = this.canvas.getContext("2d");
    const field = sim.u[this.layer];
    if (!ctx2d || !field) return;
    if (sim.dim === 1) this.drawLine(ctx2d, sim, field, gain);
    else this.drawImage(ctx2d, sim, field, gain);
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

  private drawImage(c: CanvasRenderingContext2D, sim: Simulation, f: Float32Array, gain: number): void {
    const { nx, ny, nz } = sim;
    if (!this.image || this.image.width !== nx || this.image.height !== ny) this.image = new ImageData(nx, ny);
    const data = this.image.data;
    const zOff = nz > 1 ? Math.floor(nz / 2) * nx * ny : 0;
    for (let i = 0; i < nx * ny; i++) {
      const v = Math.max(-1, Math.min(1, (f[zOff + i] ?? 0) * gain));
      const col = v >= 0 ? this.pos : this.neg;
      const a = Math.min(1, Math.abs(v));
      const o = i * 4;
      data[o] = BG[0] + (col[0] - BG[0]) * a;
      data[o + 1] = BG[1] + (col[1] - BG[1]) * a;
      data[o + 2] = BG[2] + (col[2] - BG[2]) * a;
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
