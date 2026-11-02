// The fourth dimension: a rolling history of the whole stack, x * y (downsampled) * z (the ten layers) * t (about 5 s at 10 Hz).
// From it we measure what the beat lattice only claims: how the energy of each layer sits in the beat (internal sync),
// whether it travels up or down the stack (vertical flow, as a lag between neighbouring layers) and how in phase the
// fields of neighbouring layers are over time (the sand's view of vertical sync).

import { NUM_LAYERS } from "./model";
import type { Simulation } from "./sim";

const GX = 12;
const GY = 12;
const G = GX * GY;
const T = 48;
const RATE = 10; // frames per second
const MAXLAG = 8;

export interface TesseractInfo {
  /** Per layer: how strongly its energy follows the beat (0..1) and where in the beat it peaks (0..1). */
  beatSync: number[];
  beatPeak: number[];
  /** Mean lag in ms between neighbouring layers (+ = upper layers later, the beat runs up), null if too little signal. */
  flowMs: number | null;
  /** Mean spatial correlation of the neighbouring layers over the window, -1..1. */
  verticalSync: number;
}

export class Tesseract {
  private readonly field = new Float32Array(T * NUM_LAYERS * G);
  private readonly energy = new Float32Array(NUM_LAYERS * T);
  private readonly link = new Float32Array((NUM_LAYERS - 1) * T);
  private readonly beat = new Float32Array(T).fill(-1);
  private head = 0;
  private count = 0;
  private acc = 0;
  private analysed: TesseractInfo = { beatSync: new Array<number>(NUM_LAYERS).fill(0), beatPeak: new Array<number>(NUM_LAYERS).fill(0), flowMs: null, verticalSync: 0 };
  private sinceAnalysis = 0;

  /** Call every animation frame; samples the stack 10 times a second. `beatPhase` is the machine's beat phase (0..1). */
  push(sim: Simulation, dt: number, beatPhase: number): void {
    this.acc += dt;
    if (this.acc < 1 / RATE) return;
    this.acc %= 1 / RATE;
    const t = this.head;
    const plane = sim.nx * sim.ny;
    const zMid = Math.floor(sim.nz / 2) * plane;
    const gx = Math.min(GX, sim.nx);
    const gy = Math.min(GY, sim.ny);
    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = sim.u[l];
      const o = (t * NUM_LAYERS + l) * G;
      for (let j = 0; j < G; j++) this.field[o + j] = 0;
      if (!u) continue;
      for (let y = 0; y < gy; y++) {
        const sy = Math.min(sim.ny - 1, Math.floor(((y + 0.5) * sim.ny) / gy));
        for (let x = 0; x < gx; x++) {
          const sx = Math.min(sim.nx - 1, Math.floor(((x + 0.5) * sim.nx) / gx));
          this.field[o + y * GX + x] = u[zMid + sy * sim.nx + sx] ?? 0;
        }
      }
      this.energy[l * T + t] = sim.rms[l] ?? 0;
    }
    for (let l = 0; l < NUM_LAYERS - 1; l++) {
      const a = (t * NUM_LAYERS + l) * G;
      const b = a + G;
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let j = 0; j < G; j++) {
        const x = this.field[a + j] ?? 0;
        const y = this.field[b + j] ?? 0;
        ab += x * y;
        aa += x * x;
        bb += y * y;
      }
      this.link[l * T + t] = aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
    }
    this.beat[t] = beatPhase;
    this.head = (t + 1) % T;
    this.count = Math.min(T, this.count + 1);
    if (++this.sinceAnalysis >= 5) {
      this.sinceAnalysis = 0;
      this.analyse();
    }
  }

  /** Index into the ring of the i-th oldest frame. */
  private at(i: number): number {
    return (this.head - this.count + i + T * 2) % T;
  }

  private series(l: number): number[] {
    return Array.from({ length: this.count }, (_, i) => this.energy[l * T + this.at(i)] ?? 0);
  }

  private analyse(): void {
    if (this.count < 20) return;
    const beatSync: number[] = [];
    const beatPeak: number[] = [];
    const series: number[][] = [];
    for (let l = 0; l < NUM_LAYERS; l++) {
      const e = this.series(l);
      series.push(e);
      const lo = Math.min(...e);
      let re = 0;
      let im = 0;
      let w = 0;
      for (let i = 0; i < e.length; i++) {
        const ph = this.beat[this.at(i)] ?? -1;
        if (ph < 0) continue;
        const wt = (e[i] ?? 0) - lo;
        re += wt * Math.cos(2 * Math.PI * ph);
        im += wt * Math.sin(2 * Math.PI * ph);
        w += wt;
      }
      beatSync.push(w > 1e-9 ? Math.hypot(re, im) / w : 0);
      beatPeak.push((((Math.atan2(im, re) / (2 * Math.PI)) % 1) + 1) % 1);
    }
    let lagSum = 0;
    let lagN = 0;
    for (let l = 0; l < NUM_LAYERS - 1; l++) {
      const a = series[l] ?? [];
      const b = series[l + 1] ?? [];
      const ma = a.reduce((s, v) => s + v, 0) / a.length;
      const mb = b.reduce((s, v) => s + v, 0) / b.length;
      let best = 0;
      let bestC = 0.3; // only count clear relations
      for (let lag = -MAXLAG; lag <= MAXLAG; lag++) {
        let ab = 0;
        let aa = 0;
        let bb = 0;
        for (let i = Math.max(0, -lag); i < Math.min(a.length, b.length - lag); i++) {
          const x = (a[i] ?? 0) - ma;
          const y = (b[i + lag] ?? 0) - mb;
          ab += x * y;
          aa += x * x;
          bb += y * y;
        }
        const c = aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
        if (c > bestC) {
          bestC = c;
          best = lag;
        }
      }
      if (bestC > 0.3) {
        lagSum += best;
        lagN++;
      }
    }
    let vs = 0;
    for (let l = 0; l < NUM_LAYERS - 1; l++) for (let i = 0; i < this.count; i++) vs += this.link[l * T + this.at(i)] ?? 0;
    this.analysed = {
      beatSync,
      beatPeak,
      flowMs: lagN >= 3 ? (lagSum / lagN) * (1000 / RATE) : null,
      verticalSync: vs / ((NUM_LAYERS - 1) * this.count),
    };
  }

  info(): TesseractInfo {
    return this.analysed;
  }

  /** Top: energy per layer over time (bright = loud, normalised per layer; ticks on the beat). Bottom: vertical sync of each link over time. */
  draw(canvas: HTMLCanvasElement): void {
    const c = canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = canvas;
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    const x0 = 22;
    const cw = (w - x0) / T;
    const rowE = 6;
    const rowL = 4;
    const topH = rowE * NUM_LAYERS;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const e = this.series(l);
      const hi = Math.max(1e-6, ...e);
      const y = (NUM_LAYERS - 1 - l) * rowE; // layer 1 at the bottom, like the stack
      c.fillStyle = "#93a0b3";
      c.font = "8px system-ui";
      c.fillText(`L${l + 1}`, 1, y + rowE);
      for (let i = 0; i < e.length; i++) {
        const v = Math.sqrt((e[i] ?? 0) / hi);
        c.fillStyle = `hsl(${30 + l * 18},80%,${8 + 55 * v}%)`;
        c.fillRect(x0 + (T - e.length + i) * cw, y, Math.ceil(cw), rowE - 1);
      }
    }
    let prev = -1;
    for (let i = 0; i < this.count; i++) {
      const ph = this.beat[this.at(i)] ?? -1;
      if (prev >= 0 && ph >= 0 && ph < prev - 0.5) {
        c.fillStyle = "rgba(255,255,255,0.35)";
        c.fillRect(x0 + (T - this.count + i) * cw, 0, 1, topH + 3 + rowL * (NUM_LAYERS - 1));
      }
      prev = ph;
    }
    const y0 = topH + 3;
    for (let l = 0; l < NUM_LAYERS - 1; l++) {
      const y = y0 + (NUM_LAYERS - 2 - l) * rowL;
      for (let i = 0; i < this.count; i++) {
        const v = this.link[l * T + this.at(i)] ?? 0;
        c.fillStyle = v >= 0 ? `rgba(120,220,160,${Math.min(1, v)})` : `rgba(230,100,100,${Math.min(1, -v)})`;
        c.fillRect(x0 + (T - this.count + i) * cw, y, Math.ceil(cw), rowL - 1);
      }
    }
    c.fillStyle = "#93a0b3";
    c.font = "8px system-ui";
    c.fillText("sync", 1, y0 + 14);
  }
}
