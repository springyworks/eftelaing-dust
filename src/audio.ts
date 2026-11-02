// Wave-tank monitor: FM audification of features measured on the live layer fields.
//
// Per layer one FM voice (sine carrier + sine modulator):
//   carrier pitch  = measured rms angular frequency of the field (|v|/|u|), scaled into the audible range
//   carrier level  = field rms
//   FM index       = crest factor (peaky / turbulent fields get brighter) x FM depth
//   mod ratio      = phase lock with the neighbouring layers (locked = simple 2:1, unlocked = inharmonic)
// Detected spikes (sudden velocity jumps) additionally fire a short, bright FM pluck.

import { NUM_LAYERS, clamp, type Params } from "./model";
import type { Simulation } from "./sim";

const HZ_PER_OMEGA = 1600; // sim rad/step -> Hz (omega 0.05 = 80 Hz)

interface Voice {
  car: OscillatorNode;
  mod: OscillatorNode;
  modGain: GainNode;
  gain: GainNode;
}

export class WaveMonitor {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private lastPluck = new Float64Array(NUM_LAYERS);
  analyser: AnalyserNode | null = null;
  enabled = false;
  readonly pitchHz = new Float32Array(NUM_LAYERS);
  readonly index = new Float32Array(NUM_LAYERS);

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
    const comp = ctx.createDynamicsCompressor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    master.connect(comp).connect(analyser).connect(ctx.destination);
    this.voices = Array.from({ length: NUM_LAYERS }, (_, i) => {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      car.frequency.value = 110;
      mod.frequency.value = 220;
      gain.gain.value = 0;
      pan.pan.value = (i / (NUM_LAYERS - 1)) * 1.6 - 0.8;
      mod.connect(modGain).connect(car.frequency);
      car.connect(gain).connect(pan).connect(master);
      car.start();
      mod.start();
      return { car, mod, modGain, gain };
    });
    this.ctx = ctx;
    this.master = master;
    this.analyser = analyser;
    void ctx.suspend();
  }

  update(sim: Simulation, p: Params, selected: number): void {
    // Features are exposed for the monitor panel even when audio is off.
    for (let l = 0; l < NUM_LAYERS; l++) {
      const hz = clamp((sim.freq[l] ?? 0.05) * HZ_PER_OMEGA, 40, 1600);
      const lock = Math.max(sim.lock[l] ?? 0, l > 0 ? sim.lock[l - 1] ?? 0 : 0);
      this.pitchHz[l] = hz;
      this.index[l] = p.fmDepth * (0.3 + 0.6 * ((sim.crest[l] ?? 1) - 1) + 1.5 * (1 - lock));
    }
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.master) return;
    const now = ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume * 0.6, now, 0.05);
    this.voices.forEach((v, l) => {
      const hz = this.pitchHz[l] ?? 110;
      const lock = Math.max(sim.lock[l] ?? 0, l > 0 ? sim.lock[l - 1] ?? 0 : 0);
      const ratio = 2 - (1 - lock) * 0.586;
      const level = clamp((sim.rms[l] ?? 0) / 0.35, 0, 1);
      const solo = p.listen === "solo";
      const audible = solo ? (l === selected ? 0.5 : 0) : 0.14;
      v.car.frequency.setTargetAtTime(hz, now, 0.06);
      v.mod.frequency.setTargetAtTime(hz * ratio, now, 0.06);
      v.modGain.gain.setTargetAtTime((this.index[l] ?? 0) * hz * ratio, now, 0.06);
      v.gain.gain.setTargetAtTime(level ** 1.5 * audible, now, 0.06);
    });
    for (let l = 0; l < NUM_LAYERS; l++) {
      const mag = sim.spikes[l] ?? 0;
      if (mag > 0 && (p.listen === "all" || l === selected) && now - (this.lastPluck[l] ?? 0) > 0.12) {
        this.pluck(l, mag, p.fmDepth);
        this.lastPluck[l] = now;
      }
    }
  }

  // One-shot bright FM burst for a detected spike or a fired pulse.
  pluck(layer: number, magnitude: number, depth: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.master) return;
    const t = ctx.currentTime;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();
    const hz = (this.pitchHz[layer] || 110) * 2;
    car.frequency.value = hz;
    mod.frequency.value = hz * 3.5;
    modGain.gain.setValueAtTime(hz * 3.5 * (1 + 4 * depth) * Math.min(1.5, magnitude / 2), t);
    modGain.gain.exponentialRampToValueAtTime(1, t + 0.18);
    env.gain.setValueAtTime(0.22, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    mod.connect(modGain).connect(car.frequency);
    car.connect(env).connect(this.master);
    car.start(t);
    mod.start(t);
    car.stop(t + 0.22);
    mod.stop(t + 0.22);
  }

  ping(layer: number): void {
    this.pluck(layer, 3, 0.8);
  }

  spectrum(canvas: HTMLCanvasElement): void {
    const c = canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = canvas;
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    const an = this.analyser;
    if (!an || !this.enabled) {
      c.fillStyle = "#93a0b3";
      c.font = "12px system-ui";
      c.fillText("Sound off: press S or the Sound button", 10, h / 2);
      return;
    }
    const bins = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(bins);
    const shown = 256;
    const grad = c.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "#3a5fd0");
    grad.addColorStop(1, "#ffb347");
    c.fillStyle = grad;
    for (let i = 0; i < shown; i++) {
      const v = (bins[i] ?? 0) / 255;
      c.fillRect((i / shown) * w, h - v * h, w / shown + 0.5, v * h);
    }
  }
}
