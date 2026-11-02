// Sonification: the ten layers are ten voices of one instrument.

import { NUM_LAYERS, clamp, type Params } from "./model";
import type { Simulation } from "./sim";

const SEMITONES = [0, 7, 12, 16, 19, 24, 28, 31, 36, 43];
const BASE_HZ = 55;

export class Instrument {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  private tremolo: GainNode | null = null;
  enabled = false;

  async toggle(): Promise<boolean> {
    if (!this.ctx) this.build();
    const ctx = this.ctx;
    if (!ctx) return false;
    this.enabled = !this.enabled;
    if (this.enabled) await ctx.resume();
    else await ctx.suspend();
    return this.enabled;
  }

  private build(): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    const tremolo = ctx.createGain();
    master.connect(tremolo).connect(ctx.destination);
    this.voices = Array.from({ length: NUM_LAYERS }, (_, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 8 ? "triangle" : "sine";
      osc.frequency.value = BASE_HZ * Math.pow(2, (SEMITONES[i] ?? 0) / 12);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i / (NUM_LAYERS - 1)) * 1.4 - 0.7;
      osc.connect(gain).connect(pan).connect(master);
      osc.start();
      return { osc, gain };
    });
    this.ctx = ctx;
    this.master = master;
    this.tremolo = tremolo;
    void ctx.suspend();
  }

  update(sim: Simulation, p: Params): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.master || !this.tremolo) return;
    const now = ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume * 0.5, now, 0.05);
    this.tremolo.gain.setTargetAtTime(1 - 0.25 * p.directorIntent * (0.5 + 0.5 * Math.sin(sim.t * 0.002 * 60)), now, 0.1);
    this.voices.forEach((v, i) => {
      const level = clamp((sim.rms[i] ?? 0) / 0.4, 0, 1);
      v.gain.gain.setTargetAtTime(level * level * 0.35, now, 0.08);
      const base = BASE_HZ * Math.pow(2, (SEMITONES[i] ?? 0) / 12);
      let detune = 0;
      if (i === 8) detune += p.pain * 70 * Math.sin(sim.t * 0.9) + p.ecstasy * 12 * Math.sin(sim.t * 0.05);
      detune += p.psychedelic * 18 * Math.sin(sim.t * 0.02 + i);
      v.osc.frequency.setTargetAtTime(base, now, 0.1);
      v.osc.detune.setTargetAtTime(detune, now, 0.05);
    });
  }

  ping(layer: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = BASE_HZ * 2 * Math.pow(2, (SEMITONES[layer] ?? 0) / 12);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
  }
}
