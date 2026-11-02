// Wave-tank monitor: FM audification of features measured on the live layer fields.
//
// Per layer one FM voice (sine carrier + sine modulator):
//   carrier pitch  = measured rms angular frequency of the field (|v|/|u|), scaled into the audible range
//   carrier level  = field rms
//   FM index       = crest factor (peaky / turbulent fields get brighter) x FM depth
//   mod ratio      = phase lock with the neighbouring layers (locked = simple 2:1, unlocked = inharmonic)
// Detected spikes (sudden velocity jumps) additionally fire a short, bright FM pluck.
//
// Every layer voice then goes through a parametric structural binaural synthesiser (Brown & Duda, see
// knowlege_source/Hearing.md): distance gain and air absorption, interaural time difference (Woodworth),
// head-shadow shelf filters (interaural level difference), elevation-dependent pinna notches, a front/back shelf and an
// early-reflection plus diffuse reverb send. The position of a voice is projected from its tank: the layer index sets
// the base azimuth and elevation, the energy centroid of the wave field moves the voice around.
//
// Jazz band: in "brain", "layer1" or "both" mode the brain (or layer 1 alone) plays a small band on a MIDI-style synthesiser (see band.ts); every
// instrument is its own binaural source, placed in the same scene as the layers.
//
// Raw jazz: pitches can be snapped to the chord tones of a ii-V-I-VI loop and plucks to a swung eighth-note grid.

import { LAYERS, NUM_LAYERS, clamp, type Params } from "./model";
import { Band } from "./band";
import type { Simulation } from "./sim";

const HZ_PER_OMEGA = 1600; // sim rad/step -> Hz (omega 0.05 = 80 Hz)
const HEAD_RADIUS = 0.0875; // m
const SOUND_SPEED = 343; // m/s
const ROOT_HZ = 146.83; // D3
const TEMPO = 92; // bpm
const BEAT = 60 / TEMPO;

// Chord tones (semitones above D) of Dm11 | G13 | Cmaj9#11 | A7b9b13, two bars each.
const CHORDS: readonly { name: string; tones: readonly number[] }[] = [
  { name: "Dm11", tones: [0, 2, 5, 7, 9] },
  { name: "G13", tones: [5, 9, 0, 2, 11] },
  { name: "Cmaj9#11", tones: [10, 2, 4, 6, 9] },
  { name: "A7b9b13", tones: [7, 11, 2, 5, 8] },
];

export function chordAt(time: number): { index: number; name: string } {
  const index = Math.floor(time / (8 * BEAT)) % CHORDS.length;
  return { index, name: CHORDS[index]?.name ?? "" };
}

// Snaps a frequency towards the nearest tone of the chord; amount 0 = untouched, 1 = fully snapped.
export function snapHz(hz: number, amount: number, chord: number): number {
  if (amount <= 0) return hz;
  const tones = CHORDS[chord]?.tones ?? [0];
  const semis = 12 * Math.log2(hz / ROOT_HZ);
  const base = Math.round(semis);
  let best = base;
  let bestDist = Infinity;
  for (let k = base - 6; k <= base + 6; k++) {
    const pc = ((k % 12) + 12) % 12;
    if (!tones.includes(pc)) continue;
    const d = Math.abs(k - semis);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return hz * Math.pow(ROOT_HZ * Math.pow(2, best / 12) / hz, amount);
}

// Next slot of a swung eighth-note grid at or after `time` (amount 0..1: straight to triplet swing).
export function swingSlot(time: number, amount: number): number {
  const eighth = BEAT / 2;
  const k0 = Math.floor(time / eighth) - 1;
  for (let k = k0; k < k0 + 4; k++) {
    const t = Math.floor(k / 2) * BEAT + (k % 2 === 0 ? 0 : BEAT * (0.5 + amount / 6));
    if (t >= time - 1e-4) return t;
  }
  return time;
}

export interface Cues {
  itdUs: number;
  ildDb: number; // near-ear minus far-ear level at high frequencies
  notchHz: number;
}

// Structural cues for a source at azimuth az (deg, +right, 0 front), elevation el (deg).
export function binauralCues(az: number, el: number): Cues {
  const a = (az * Math.PI) / 180;
  const fold = Math.abs(az) > 90 ? Math.sign(az) * (180 - Math.abs(az)) : az; // front/back mirror: same ITD
  const th = (Math.abs(fold) * Math.PI) / 180;
  const itd = (HEAD_RADIUS / SOUND_SPEED) * (th + Math.sin(th));
  const near = clamp(1 + Math.abs(Math.sin(a)), 0.1, 2);
  const far = clamp(1 - Math.abs(Math.sin(a)), 0.1, 2);
  const notch = 5500 + 5500 * (clamp(el, -45, 90) + 45) / 135;
  return { itdUs: itd * 1e6 * Math.sign(az || 1), ildDb: 20 * Math.log10(near / far), notchHz: notch };
}

// One mono source placed in space.
class Spatializer {
  readonly input: GainNode;
  private readonly air: BiquadFilterNode;
  private readonly dist: GainNode;
  private readonly send: GainNode;
  private readonly binGain: GainNode;
  private readonly panGain: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly ear: { delay: DelayNode; shelf: BiquadFilterNode; n1: BiquadFilterNode; n2: BiquadFilterNode; back: BiquadFilterNode }[];

  constructor(ctx: AudioContext, out: AudioNode, reverbIn: AudioNode) {
    this.input = ctx.createGain();
    this.air = ctx.createBiquadFilter();
    this.air.type = "lowpass";
    this.air.frequency.value = 18000;
    this.dist = ctx.createGain();
    this.send = ctx.createGain();
    this.binGain = ctx.createGain();
    this.panGain = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.input.connect(this.air).connect(this.dist);
    this.input.connect(this.send).connect(reverbIn);
    this.dist.connect(this.binGain);
    this.dist.connect(this.panGain).connect(this.pan).connect(out);
    const merger = ctx.createChannelMerger(2);
    this.ear = [0, 1].map((ch) => {
      const delay = ctx.createDelay(0.01);
      const shelf = ctx.createBiquadFilter();
      shelf.type = "highshelf";
      shelf.frequency.value = 800;
      const n1 = ctx.createBiquadFilter();
      const n2 = ctx.createBiquadFilter();
      for (const n of [n1, n2]) {
        n.type = "peaking";
        n.Q.value = 5;
        n.gain.value = -10;
      }
      const back = ctx.createBiquadFilter();
      back.type = "highshelf";
      back.frequency.value = 8000;
      this.binGain.connect(delay);
      delay.connect(shelf).connect(n1).connect(n2).connect(back).connect(merger, 0, ch);
      return { delay, shelf, n1, n2, back };
    });
    merger.connect(out);
  }

  set(az: number, el: number, r: number, binaural: boolean, reverb: number, now: number): void {
    const tc = 0.04;
    const a = (az * Math.PI) / 180;
    const cues = binauralCues(az, el);
    const itd = Math.abs(cues.itdUs) / 1e6;
    const base = 0.0008;
    const [left, right] = this.ear;
    if (!left || !right) return;
    left.delay.delayTime.setTargetAtTime(base + (az > 0 ? itd : 0), now, tc);
    right.delay.delayTime.setTargetAtTime(base + (az < 0 ? itd : 0), now, tc);
    const s = Math.sin(a);
    const db = (alpha: number): number => 20 * Math.log10(clamp(alpha, 0.1, 2));
    left.shelf.gain.setTargetAtTime(db(1 - s), now, tc);
    right.shelf.gain.setTargetAtTime(db(1 + s), now, tc);
    const back = -7 * Math.max(0, -Math.cos(a));
    for (const e of this.ear) {
      e.n1.frequency.setTargetAtTime(cues.notchHz, now, tc);
      e.n2.frequency.setTargetAtTime(Math.min(17000, cues.notchHz * 1.45), now, tc);
      e.back.gain.setTargetAtTime(back, now, tc);
    }
    this.air.frequency.setTargetAtTime(clamp(18000 / (1 + r * 0.35), 3000, 18000), now, tc);
    this.dist.gain.setTargetAtTime(1 / Math.max(1, r), now, tc);
    this.send.gain.setTargetAtTime(reverb * Math.min(1, 0.25 + 0.2 * r), now, tc);
    this.binGain.gain.setTargetAtTime(binaural ? 1 : 0, now, tc);
    this.panGain.gain.setTargetAtTime(binaural ? 0 : 1, now, tc);
    this.pan.pan.setTargetAtTime(clamp(s, -1, 1), now, tc);
  }
}

// Synthetic room: early reflections at 5-30 ms with their own left/right balance, then a decorrelated decaying tail.
function roomImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 1.6);
  const buf = ctx.createBuffer(2, len, sr);
  const early = [0.005, 0.011, 0.017, 0.023, 0.029];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 4.2) * 0.35 * Math.min(1, t / 0.03);
    }
    early.forEach((t, k) => {
      const i = Math.floor((t + (ch ? 0.0013 * (k % 2 ? 1 : -1) : 0)) * sr);
      d[i] = (d[i] ?? 0) + (ch === k % 2 ? 0.9 : 0.5) * (k % 2 ? -1 : 1) * Math.pow(0.8, k);
    });
  }
  return buf;
}

export interface SceneVoice {
  az: number;
  el: number;
  r: number;
  level: number;
  spike: number;
}

interface Voice {
  car: OscillatorNode;
  mod: OscillatorNode;
  modGain: GainNode;
  gain: GainNode;
  spat: Spatializer;
}

export class WaveMonitor {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private lastPluck = new Float64Array(NUM_LAYERS);
  band: Band | null = null;
  private bandBus: GainNode | null = null;
  private lastParams: Params | null = null;
  private alc: GainNode | null = null;
  private alcIn: AnalyserNode | null = null;
  private alcGain = 1;
  private alcLast = 0;
  private clipHold = 0;
  private readonly alcBuf = new Float32Array(2048);
  private limiter: DynamicsCompressorNode | null = null;
  private meterL: AnalyserNode | null = null;
  private meterR: AnalyserNode | null = null;
  private readonly meterBuf = new Float32Array(1024);
  analyser: AnalyserNode | null = null;
  enabled = false;
  chord = "";
  readonly pitchHz = new Float32Array(NUM_LAYERS);
  readonly index = new Float32Array(NUM_LAYERS);
  readonly scene: SceneVoice[] = Array.from({ length: NUM_LAYERS }, () => ({ az: 0, el: 0, r: 2, level: 0, spike: 0 }));

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
    // Output stage: ALC gain (feed-forward from a peak watcher) -> fast limiter -> tanh soft clipper -> out.
    const alc = ctx.createGain();
    const alcIn = ctx.createAnalyser();
    alcIn.fftSize = 2048;
    alcIn.smoothingTimeConstant = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -2;
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(4096);
    // Transparent (slope 1) up to 0.7, then a smooth tanh knee that tops out at 0.98.
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a <= 0.7 ? a : 0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
    }
    clip.curve = curve;
    clip.oversample = "4x";
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    // The watcher sees the signal 35 ms before it reaches the ALC gain, so a peak is already ducked when it arrives.
    const ahead = ctx.createDelay(0.1);
    ahead.delayTime.value = 0.035;
    master.connect(alcIn);
    master.connect(ahead).connect(alc);
    // The compressor applies an automatic make-up gain (about 1.14 for these settings); undo it so the ceiling is honest.
    const unmake = ctx.createGain();
    unmake.gain.value = 0.876;
    alc.connect(comp).connect(unmake).connect(clip).connect(analyser).connect(ctx.destination);
    this.alc = alc;
    this.alcIn = alcIn;
    this.limiter = comp;
    const split = ctx.createChannelSplitter(2);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = this.meterR.fftSize = 1024;
    clip.connect(split);
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    const verb = ctx.createConvolver();
    verb.buffer = roomImpulse(ctx);
    verb.connect(master);
    const bandBus = ctx.createGain();
    bandBus.gain.value = 1;
    bandBus.connect(master);
    this.bandBus = bandBus;
    this.band = new Band(ctx, () => new Spatializer(ctx, bandBus, verb));
    this.voices = Array.from({ length: NUM_LAYERS }, () => {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const gain = ctx.createGain();
      const spat = new Spatializer(ctx, master, verb);
      car.frequency.value = 110;
      mod.frequency.value = 220;
      gain.gain.value = 0;
      mod.connect(modGain).connect(car.frequency);
      car.connect(gain).connect(spat.input);
      car.start();
      mod.start();
      return { car, mod, modGain, gain, spat };
    });
    this.ctx = ctx;
    this.master = master;
    this.analyser = analyser;
    void ctx.suspend();
  }

  // Automatic level control: attack instantly on a peak over the ceiling, release slowly (about 1.5 s).
  private levelControl(ceiling: number, now: number): void {
    const an = this.alcIn;
    if (!an || !this.alc) return;
    an.getFloatTimeDomainData(this.alcBuf);
    let peak = 0;
    for (const s of this.alcBuf) peak = Math.max(peak, Math.abs(s));
    const dt = Math.min(0.2, Math.max(0.001, now - this.alcLast));
    this.alcLast = now;
    const need = peak > 1e-4 ? Math.min(1, ceiling / peak) : 1;
    if (need < this.alcGain) this.alcGain = need;
    else this.alcGain += (need - this.alcGain) * (1 - Math.exp(-dt / 1.5));
    this.alc.gain.setTargetAtTime(this.alcGain, now, 0.004);
    if (peak * this.alcGain > 0.97) this.clipHold = 1;
    else this.clipHold = Math.max(0, this.clipHold - dt);
  }

  // Gain reduction of the ALC plus the limiter, in dB (0 or negative).
  get reductionDb(): number {
    return 20 * Math.log10(Math.max(1e-3, this.alcGain)) + (this.limiter?.reduction ?? 0);
  }

  update(sim: Simulation, p: Params, selected: number): void {
    this.lastParams = p;
    const ctx = this.ctx;
    const clock = ctx ? ctx.currentTime : performance.now() / 1000;
    const live = !!ctx && this.enabled && !!this.band;
    if (live && ctx) this.band?.update(sim, p, ctx.currentTime, this.scene, this.pitchHz);
    const chord = live && this.band ? { index: this.band.chordIndex, name: this.band.chordName } : chordAt(clock);
    this.chord = chord.name;
    // Features and scene positions are exposed for the panels even when audio is off.
    for (let l = 0; l < NUM_LAYERS; l++) {
      const raw = clamp((sim.freq[l] ?? 0.05) * HZ_PER_OMEGA, 40, 1600);
      const lock = Math.max(sim.lock[l] ?? 0, l > 0 ? sim.lock[l - 1] ?? 0 : 0);
      this.pitchHz[l] = snapHz(raw, p.jazz, chord.index);
      this.index[l] = p.fmDepth * (0.3 + 0.6 * ((sim.crest[l] ?? 1) - 1) + 1.5 * (1 - lock));
      const sv = this.scene[l];
      if (sv) {
        const cx = sim.cen[l * 3] ?? 0.5;
        const cy = sim.cen[l * 3 + 1] ?? 0.5;
        const cz = sim.cen[l * 3 + 2] ?? 0.5;
        sv.az = ((l / (NUM_LAYERS - 1)) * 2 - 1) * 75 * p.width + (cx - 0.5) * 70 * p.width;
        sv.el = -25 + 85 * (l / (NUM_LAYERS - 1)) + (0.5 - cy) * 40;
        sv.r = clamp(1 + 4 * (1 - lock) + (cz - 0.5) * 1.5, 0.6, 6);
        sv.level = clamp((sim.rms[l] ?? 0) / 0.35, 0, 1);
        sv.spike = Math.max((sv.spike ?? 0) * 0.85, sim.spikes[l] ?? 0);
      }
    }
    if (!ctx || !this.enabled || !this.master) return;
    const now = ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume * 0.6, now, 0.05);
    this.levelControl(p.alcCeiling, now);
    const glide = p.jazz > 0 ? 0.03 : 0.06;
    const rawMix = (p.audioMode === "raw" ? 1 : p.audioMode === "both" ? 0.6 : 0) * p.rawLevel;
    this.bandBus?.gain.setTargetAtTime((p.audioMode === "raw" ? 0 : p.audioMode === "both" ? 0.8 : 1) * p.bandLevel, now, 0.05);
    this.voices.forEach((v, l) => {
      const hz = this.pitchHz[l] ?? 110;
      const lock = Math.max(sim.lock[l] ?? 0, l > 0 ? sim.lock[l - 1] ?? 0 : 0);
      const ratio = 2 - (1 - lock) * 0.586;
      const level = clamp((sim.rms[l] ?? 0) / 0.35, 0, 1);
      const solo = p.listen === "solo";
      const audible = (solo ? (l === selected ? 0.5 : 0) : 0.14) * rawMix;
      v.car.frequency.setTargetAtTime(hz, now, glide);
      v.mod.frequency.setTargetAtTime(hz * ratio, now, glide);
      v.modGain.gain.setTargetAtTime((this.index[l] ?? 0) * hz * ratio, now, glide);
      v.gain.gain.setTargetAtTime(level ** 1.5 * audible, now, 0.06);
      const sv = this.scene[l];
      if (sv) v.spat.set(sv.az, sv.el, sv.r, p.spatial === "binaural", p.reverb, now);
    });
    for (let l = 0; l < NUM_LAYERS; l++) {
      const mag = sim.spikes[l] ?? 0;
      if (mag > 0 && (p.listen === "all" || l === selected) && now - (this.lastPluck[l] ?? 0) > 0.12) {
        this.pluck(l, mag, p.fmDepth);
        this.lastPluck[l] = now;
      }
    }
  }

  // One-shot bright FM burst for a detected spike or a fired pulse; swung to the grid and snapped to the chord.
  pluck(layer: number, magnitude: number, depth: number, pitchMul = 1): void {
    const ctx = this.ctx;
    const voice = this.voices[layer];
    if (!ctx || !this.enabled || !this.master || !voice) return;
    const p = this.lastParams;
    if (p && p.audioMode !== "raw" && pitchMul === 1) this.band?.accent(layer, magnitude);
    if (p?.audioMode === "brain" || p?.audioMode === "layer1") return;
    const swing = p?.swing ?? 0;
    const slot = this.band ? this.band.nextSlot(ctx.currentTime, swing) : swingSlot(ctx.currentTime, swing);
    const t = swing > 0 ? Math.min(slot, ctx.currentTime + 0.4) : ctx.currentTime;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();
    const hz = snapHz((this.pitchHz[layer] || 110) * 2 * pitchMul, p?.jazz ?? 0, this.band?.chordIndex ?? chordAt(t).index);
    car.frequency.value = hz;
    mod.frequency.value = hz * 3.5;
    modGain.gain.setValueAtTime(hz * 3.5 * (1 + 4 * depth) * Math.min(1.5, magnitude / 2), t);
    modGain.gain.exponentialRampToValueAtTime(1, t + 0.18);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.22, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    mod.connect(modGain).connect(car.frequency);
    car.connect(env).connect(voice.spat.input);
    car.start(t);
    mod.start(t);
    car.stop(t + 0.22);
    mod.stop(t + 0.22);
  }

  ping(layer: number): void {
    this.pluck(layer, 3, 0.8);
  }

  // A character typed into layer 1: the band plays it and the brain answers in MIDI; the raw FM voice of layer 1 plucks too.
  typeChar(code: number): void {
    const p = this.lastParams;
    if (!this.enabled) return;
    if (p && p.audioMode !== "raw") this.band?.type(code);
    this.pluck(0, 2, 0.6, 2 ** ((code % 12) / 12));
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

  private level(an: AnalyserNode | null): number {
    if (!an || !this.enabled) return 0;
    an.getFloatTimeDomainData(this.meterBuf);
    let s = 0;
    for (const x of this.meterBuf) s += x * x;
    return Math.min(1, Math.sqrt(s / this.meterBuf.length) * 4);
  }

  // Plan view (head at the centre, nose up) and side view of the ten voices, plus left/right level meters.
  drawScene(canvas: HTMLCanvasElement, selected: number): void {
    const c = canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = canvas;
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    const pw = w * 0.56;
    const cx = pw / 2;
    const cy = h * 0.52;
    const R = Math.min(pw / 2, h * 0.46) - 4;
    const rmax = 6;
    c.strokeStyle = "#1d2530";
    c.fillStyle = "#93a0b3";
    c.font = "10px system-ui";
    for (const m of [1, 2, 4, 6]) {
      c.beginPath();
      c.arc(cx, cy, (m / rmax) * R, 0, Math.PI * 2);
      c.stroke();
      c.fillText(`${m} m`, cx + 3, cy - (m / rmax) * R + 10);
    }
    c.beginPath();
    c.moveTo(cx, cy - R);
    c.lineTo(cx, cy + R);
    c.moveTo(cx - R, cy);
    c.lineTo(cx + R, cy);
    c.stroke();
    c.fillStyle = "#cfd8e6";
    c.beginPath();
    c.ellipse(cx, cy, 9, 11, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.moveTo(cx - 3, cy - 10);
    c.lineTo(cx, cy - 17);
    c.lineTo(cx + 3, cy - 10);
    c.fill();
    c.fillRect(cx - 12, cy - 3, 4, 6);
    c.fillRect(cx + 8, cy - 3, 4, 6);
    c.fillStyle = "#93a0b3";
    c.fillText("plan: front is up", 6, 12);

    const sx0 = pw + 14;
    const sw = w - sx0 - 8;
    const sh = h * 0.72;
    const baseY = h * 0.5 + sh * 0.1;
    c.strokeStyle = "#1d2530";
    c.beginPath();
    c.moveTo(sx0, baseY);
    c.lineTo(sx0 + sw, baseY);
    c.stroke();
    c.fillStyle = "#93a0b3";
    c.fillText("side: front is right", sx0, 12);
    c.fillStyle = "#cfd8e6";
    c.beginPath();
    c.arc(sx0 + sw / 2, baseY, 7, 0, Math.PI * 2);
    c.fill();

    this.scene.forEach((v, l) => {
      const info = LAYERS[l];
      if (!info) return;
      const a = (v.az * Math.PI) / 180;
      const e = (v.el * Math.PI) / 180;
      const rr = (v.r / rmax) * R;
      const px = cx + Math.sin(a) * rr;
      const py = cy - Math.cos(a) * rr;
      const dot = 3 + 6 * v.level + (l === selected ? 2 : 0);
      c.fillStyle = info.color;
      c.globalAlpha = 0.35 + 0.65 * Math.max(v.level, 0.3);
      c.beginPath();
      c.arc(px, py, dot, 0, Math.PI * 2);
      c.fill();
      if (v.spike > 0.2) {
        c.strokeStyle = "#ff5a3c";
        c.beginPath();
        c.arc(px, py, dot + 4 + 3 * v.spike, 0, Math.PI * 2);
        c.stroke();
      }
      c.globalAlpha = 1;
      c.fillStyle = "#e6eaf0";
      c.fillText(`${info.id}`, px + dot + 2, py + 3);
      const fwd = Math.cos(a) * Math.cos(e) * (v.r / rmax);
      const sxp = sx0 + sw / 2 + fwd * (sw / 2 - 8);
      const syp = baseY - Math.sin(e) * (v.r / rmax) * sh * 0.9;
      c.fillStyle = info.color;
      c.beginPath();
      c.arc(sxp, syp, dot * 0.7, 0, Math.PI * 2);
      c.fill();
      if (l === selected) {
        c.strokeStyle = "#fff";
        c.beginPath();
        c.arc(px, py, dot + 2, 0, Math.PI * 2);
        c.stroke();
      }
    });

    // Band instruments: squares, each in its own place in the same scene.
    if (this.band && this.lastParams?.audioMode !== "raw") {
      for (const v of Object.values(this.band.voices)) {
        const a = (v.az * Math.PI) / 180;
        const e = (v.el * Math.PI) / 180;
        const rr = (v.r / rmax) * R;
        const px = cx + Math.sin(a) * rr;
        const py = cy - Math.cos(a) * rr;
        const sz = 4 + 6 * v.level;
        c.fillStyle = v.color;
        c.globalAlpha = 0.45 + 0.55 * Math.min(1, v.level * 1.5);
        c.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        const fwd = Math.cos(a) * Math.cos(e) * (v.r / rmax);
        const sxp = sx0 + sw / 2 + fwd * (sw / 2 - 8);
        const syp = baseY - Math.sin(e) * (v.r / rmax) * sh * 0.9;
        c.fillRect(sxp - sz * 0.35, syp - sz * 0.35, sz * 0.7, sz * 0.7);
        c.globalAlpha = 1;
        c.fillStyle = "#e6eaf0";
        c.fillText(v.name, px + sz / 2 + 3, py + 3);
      }
    }

    const lv = this.level(this.meterL);
    const rv = this.level(this.meterR);
    c.fillStyle = "#1d2530";
    c.fillRect(6, h - 22, pw - 12, 6);
    c.fillRect(6, h - 12, pw - 12, 6);
    c.fillStyle = "#3a5fd0";
    c.fillRect(6, h - 22, (pw - 12) * lv, 6);
    c.fillStyle = "#ffb347";
    c.fillRect(6, h - 12, (pw - 12) * rv, 6);
    const red = this.reductionDb;
    c.fillStyle = red < -6 ? "#ff5a3c" : red < -0.5 ? "#ffb347" : "#93a0b3";
    c.fillText(`ALC ${red.toFixed(1)} dB${this.clipHold > 0 ? " PEAK" : ""}`, 6, h - 27);
    c.fillStyle = "#93a0b3";
    c.fillText("L", pw - 4, h - 16);
    c.fillText("R", pw - 4, h - 6);
  }
}
