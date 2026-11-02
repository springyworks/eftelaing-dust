// A beat lattice: one phase oscillator per layer, coupled vertically so the beat runs up the stack and back down (a layer
// peaks a little after the one below it, so cos(phase) shows a wave travelling L1 -> L10 once per beat). A human onset pulls
// the bottom layer onto the beat; the coupling carries it up. This is a Kuramoto chain with a phase lag, the cheapest honest
// model of "every layer syncs internally and vertically"; the tanks' own phase locks stay in Simulation.lock.

import { NUM_LAYERS } from "./model";

const TAU = 2 * Math.PI;

export class BeatLattice {
  readonly phase = new Float32Array(NUM_LAYERS);
  /** 0..1: how well the stack follows the travelling pattern. */
  order = 0;
  coupling = 3;
  lag = 0.3; // radians between neighbouring layers
  private readonly spread = Float32Array.from({ length: NUM_LAYERS }, (_, l) => 0.03 * Math.sin(l * 2.1 + 0.7));

  step(dt: number, bpm: number): void {
    const w = (TAU * bpm) / 60;
    const nxt = new Float32Array(NUM_LAYERS);
    for (let l = 0; l < NUM_LAYERS; l++) {
      const p = this.phase[l] ?? 0;
      let d = w * (1 + (this.spread[l] ?? 0));
      if (l > 0) d += this.coupling * Math.sin((this.phase[l - 1] ?? 0) - this.lag - p);
      if (l < NUM_LAYERS - 1) d += this.coupling * Math.sin((this.phase[l + 1] ?? 0) + this.lag - p);
      nxt[l] = (p + d * dt) % TAU;
    }
    this.phase.set(nxt);
    let re = 0;
    let im = 0;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const a = (this.phase[l] ?? 0) + l * this.lag;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    this.order = Math.hypot(re, im) / NUM_LAYERS;
  }

  /** A human onset: the bottom layer is pulled `strength` (0..1) of the way onto the beat (phase 0). */
  pull(strength: number): void {
    let e = -(this.phase[0] ?? 0);
    e = ((((e + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    this.phase[0] = (this.phase[0] ?? 0) + strength * e;
  }

  /** 0..1 activity of a layer on the beat: 1 at the beat, 0 half a beat later. */
  level(l: number): number {
    return 0.5 + 0.5 * Math.cos(this.phase[l] ?? 0);
  }
}
