// The beat of the stack. One phase oscillator per layer, coupled vertically (a Kuramoto chain with a phase lag), so a beat
// runs up the ten layers in one bar and back down in the next (lag +, then lag -): the continuous up-down-up flow. Layer 1 is
// anchored to the band's audible grid, the others follow through the links, whose strength comes from the sand memory.
// The human follows the machine: Groove measures how early or late each sung or clapped onset lands on that grid.

import { NUM_LAYERS } from "./model";

const TAU = 2 * Math.PI;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export class BeatLattice {
  readonly phase = new Float32Array(NUM_LAYERS);
  /** Coupling of link l (layer l to l+1), 1/s. The caller sets it from the sand memory. */
  readonly links = new Float32Array(NUM_LAYERS - 1).fill(3);
  /** 0..1: how well the stack follows the travelling pattern. */
  order = 0;
  lag = 0; // radians between neighbouring layers now (eases towards +-LAG with the bar direction)
  dir = 1; // +1 the beat runs up in this bar, -1 down
  private readonly spread = Float32Array.from({ length: NUM_LAYERS }, (_, l) => 0.03 * Math.sin(l * 2.1 + 0.7));
  private static readonly LAG = 0.5;

  /** Advances by dt seconds. `anchor` is the band's beat phase (0..1) for layer 1, or null to free-run at `bpm`. Returns the layers that passed the beat. */
  step(dt: number, bpm: number, anchor: number | null, bar: number | null): number[] {
    if (bar !== null) this.dir = bar % 2 === 0 ? 1 : -1;
    this.lag += (this.dir * BeatLattice.LAG - this.lag) * Math.min(1, dt * 2);
    const w = (TAU * bpm) / 60;
    const old = Float32Array.from(this.phase);
    const nxt = new Float32Array(NUM_LAYERS);
    for (let l = 0; l < NUM_LAYERS; l++) {
      const p = old[l] ?? 0;
      let d = w * (1 + (this.spread[l] ?? 0));
      if (l > 0) d += (this.links[l - 1] ?? 0) * Math.sin((old[l - 1] ?? 0) - this.lag - p);
      if (l < NUM_LAYERS - 1) d += 0.3 * (this.links[l] ?? 0) * Math.sin((old[l + 1] ?? 0) - p); // the way back has no lag: only the way up is directed
      nxt[l] = (p + d * dt + TAU) % TAU;
    }
    if (anchor !== null) nxt[0] = anchor * TAU;
    const crossed: number[] = [];
    for (let l = 0; l < NUM_LAYERS; l++) if ((nxt[l] ?? 0) < (old[l] ?? 0) - Math.PI) crossed.push(l);
    this.phase.set(nxt);
    // order: how regularly the beat travels, whatever the lag per layer turned out to be
    let ds = 0;
    let dc = 0;
    for (let l = 1; l < NUM_LAYERS; l++) {
      const d = (this.phase[l] ?? 0) - (this.phase[l - 1] ?? 0);
      ds += Math.sin(d);
      dc += Math.cos(d);
    }
    const m = Math.atan2(ds, dc);
    let re = 0;
    let im = 0;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const a = (this.phase[l] ?? 0) - l * m;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    this.order = Math.hypot(re, im) / NUM_LAYERS;
    return crossed;
  }

  /** 0..1 activity of a layer on the beat: 1 at the beat, 0 half a beat later. */
  level(l: number): number {
    return 0.5 + 0.5 * Math.cos(this.phase[l] ?? 0);
  }
}

/** How well a human keeps time with the machine: signed offsets (ms, + = late) of onsets against the nearest eighth of the grid. */
export class Groove {
  readonly offsets: number[] = [];
  static readonly WINDOW = 70; // ms counted as "on the beat"
  static readonly KEEP = 24;

  /** `phase` is the beat phase (0..1) at the moment the human made the sound. */
  push(phase: number, bpm: number): { ms: number; hit: boolean } {
    const e = ((((phase * 2 + 0.5) % 1) + 1) % 1) - 0.5; // -0.5..0.5 of an eighth
    const ms = (e / 2) * (60000 / bpm);
    this.offsets.push(ms);
    if (this.offsets.length > Groove.KEEP) this.offsets.shift();
    return { ms, hit: Math.abs(ms) <= Groove.WINDOW };
  }

  /** Mean offset (bias: always late or early?), spread (jitter) and share of onsets on the beat; null before 3 onsets. */
  stats(): { bias: number; jitter: number; onBeat: number; n: number } | null {
    const n = this.offsets.length;
    if (n < 3) return null;
    const bias = this.offsets.reduce((a, b) => a + b, 0) / n;
    const jitter = Math.sqrt(this.offsets.reduce((a, b) => a + (b - bias) ** 2, 0) / n);
    const onBeat = this.offsets.filter((m) => Math.abs(m) <= Groove.WINDOW).length / n;
    return { bias, jitter, onBeat: clamp(onBeat, 0, 1), n };
  }
}
