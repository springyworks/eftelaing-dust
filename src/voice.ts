// Microphone input for one human voice: pitch detection (YIN), note segmentation (voice2midi) and detection of unpitched
// bursts ("pfff", "tss", "k") that become drum-stick hits. The analysis is pure (VoiceAnalyzer) so it can be tested without a
// browser; VoiceInput wraps it around getUserMedia and an AnalyserNode.

export type VoiceEvent =
  | { kind: "on"; midi: number; hz: number; vel: number; t: number }
  | { kind: "off"; midi: number; dur: number; staccato: boolean; t: number }
  | { kind: "hit"; vel: number; bright: number; t: number };

export interface VoiceFrame {
  level: number; // rms 0..1
  db: number;
  hz: number; // 0 when unvoiced
  midi: number; // fractional
  clarity: number; // 0..1, how periodic the sound is
  state: "idle" | "attack" | "voiced" | "noise";
  midiNote: number; // the segmented note being held, -1 when none
  gate: number; // rms the input must exceed to count as sound
}

const FMIN = 70;
const FMAX = 1000;
const STACCATO = 0.16; // seconds: shorter notes are staccato
const REFRACTORY = 0.07;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export class VoiceAnalyzer {
  /** Divides the noise gate: 1 is normal, higher hears quieter sound (and more noise). */
  sensitivity = 2;
  frame: VoiceFrame = { level: 0, db: -90, hz: 0, midi: 0, clarity: 0, state: "idle", midiNote: -1, gate: 0.01 };

  private floor = 0.002;
  private slow = 0;
  private lastOnset = -10;
  private state: VoiceFrame["state"] = "idle";
  private t0 = 0;
  private peak = 0;
  private voicedRun = 0;
  private lastMidi = 0;
  private note = -1;
  private noteStart = 0;
  private drift = 0;
  private unvoiced = 0;
  private legato = 0;

  constructor(private readonly sampleRate: number) {}

  private gate(): number {
    return Math.max(0.0012, (this.floor * 3) / this.sensitivity);
  }

  /** Velocity 1..127 from the rms level. */
  static velocity(rms: number): number {
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    return clamp(Math.round(20 + (db + 45) * 3.5), 1, 127);
  }

  /** Pitch of the newest part of buf by YIN on a 2x downsampled copy. Returns hz 0 when nothing periodic is found. */
  static pitch(buf: Float32Array, sampleRate: number): { hz: number; clarity: number } {
    const sr = sampleRate / 2;
    const tauMax = Math.floor(sr / FMIN);
    const tauMin = Math.max(2, Math.floor(sr / FMAX));
    const w = 640;
    const need = (w + tauMax) * 2;
    if (buf.length < need) return { hz: 0, clarity: 0 };
    const x = new Float32Array(w + tauMax);
    const base = buf.length - need;
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * ((buf[base + 2 * i] ?? 0) + (buf[base + 2 * i + 1] ?? 0));
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < w; j++) {
        const e = (x[j] ?? 0) - (x[j + tau] ?? 0);
        s += e * e;
      }
      d[tau] = s;
    }
    // cumulative mean normalised difference
    const n = new Float32Array(tauMax + 1);
    n[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau] ?? 0;
      n[tau] = run > 0 ? ((d[tau] ?? 0) * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if ((n[tau] ?? 1) < 0.27) {
        while (tau + 1 < tauMax && (n[tau + 1] ?? 1) < (n[tau] ?? 1)) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let m = 1;
      for (let tau = tauMin; tau < tauMax; tau++) if ((n[tau] ?? 1) < m) m = n[tau] ?? 1;
      return { hz: 0, clarity: clamp(1 - m, 0, 1) };
    }
    const a = n[best - 1] ?? 1;
    const b = n[best] ?? 1;
    const c = n[best + 1] ?? 1;
    const den = a - 2 * b + c;
    const tau = den !== 0 ? best + (a - c) / (2 * den) : best;
    return { hz: sr / tau, clarity: clamp(1 - b, 0, 1) };
  }

  /** Feed the newest block of mono samples (at least ~1900 at 44.1 kHz); `now` is a clock in seconds. Returns the events it caused. */
  process(buf: Float32Array, now: number): VoiceEvent[] {
    const out: VoiceEvent[] = [];
    const n = Math.min(buf.length, 512);
    let s2 = 0;
    let zc = 0;
    for (let i = buf.length - n; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      s2 += v * v;
      if (i > buf.length - n && (buf[i - 1] ?? 0) * v < 0) zc++;
    }
    const level = Math.sqrt(s2 / n);
    const bright = clamp((zc / n - 0.05) / 0.35, 0, 1);
    const gate = this.gate();
    const loud = level > gate;
    const p = loud ? VoiceAnalyzer.pitch(buf, this.sampleRate) : { hz: 0, clarity: 0 };
    const voiced = loud && p.hz > 0 && p.clarity >= 0.72;
    const midi = voiced ? 69 + 12 * Math.log2(p.hz / 440) : 0;

    // the noise floor follows quiet sound fast and an endless unvoiced racket slowly, never a sung note
    if (this.state === "idle" && !loud) this.floor += 0.02 * (level - this.floor);
    else if (this.state === "noise" || (this.state === "idle" && !voiced)) this.floor += 0.003 * (level - this.floor);
    const onset = loud && level > this.slow * 1.7 + gate * 0.4 && now - this.lastOnset > REFRACTORY;
    this.slow += 0.15 * (level - this.slow);

    const endNote = (): void => {
      if (this.note < 0) return;
      const dur = now - this.noteStart;
      out.push({ kind: "off", midi: this.note, dur, staccato: dur < STACCATO, t: now });
      this.note = -1;
    };
    const startNote = (m: number): void => {
      this.legato = 0;
      this.note = Math.round(m);
      this.noteStart = now;
      this.drift = 0;
      out.push({ kind: "on", midi: this.note, hz: 440 * 2 ** ((this.note - 69) / 12), vel: VoiceAnalyzer.velocity(this.peak), t: now });
      this.state = "voiced";
    };
    const beginAttack = (): void => {
      this.state = "attack";
      this.t0 = now;
      this.peak = level;
      this.voicedRun = 0;
      this.lastOnset = now;
    };

    switch (this.state) {
      case "idle":
        if (onset) beginAttack();
        else if (voiced) {
          // a steady hummed note without a new attack (legato) still counts once it has lasted a moment
          this.legato++;
          this.lastMidi = midi;
          if (this.legato >= 8) {
            this.peak = level;
            startNote(midi);
          }
        } else this.legato = 0;
        break;
      case "attack": {
        this.peak = Math.max(this.peak, level);
        if (voiced) {
          this.voicedRun++;
          this.lastMidi = midi;
        } else this.voicedRun = 0;
        const age = now - this.t0;
        if (this.voicedRun >= 3) startNote(this.lastMidi);
        else if (age > 0.045 && this.voicedRun === 0) {
          out.push({ kind: "hit", vel: VoiceAnalyzer.velocity(this.peak), bright, t: now });
          this.state = "noise";
        } else if (!loud || age > 0.12) {
          if (this.lastMidi > 0 && this.voicedRun > 0) startNote(this.lastMidi);
          else {
            out.push({ kind: "hit", vel: VoiceAnalyzer.velocity(this.peak), bright, t: now });
            this.state = "idle";
          }
        }
        break;
      }
      case "voiced": {
        if (onset) {
          endNote();
          beginAttack();
          break;
        }
        if (voiced) {
          this.unvoiced = 0;
          this.drift = Math.abs(midi - this.note) > 0.7 ? this.drift + 1 : 0;
          if (this.drift >= 4) {
            endNote();
            this.peak = level;
            startNote(midi);
          }
        } else this.unvoiced++;
        if (level < gate * 0.7 || this.unvoiced >= 5) {
          endNote();
          this.state = "idle";
        }
        break;
      }
      case "noise":
        if (level < gate * 0.7) this.state = "idle";
        break;
    }
    this.frame = { level, db: 20 * Math.log10(Math.max(level, 1e-5)), hz: voiced ? p.hz : 0, midi, clarity: p.clarity, state: this.state, midiNote: this.note, gate };
    return out;
  }
}

/** Median inter-onset interval of recent human onsets, folded into 60..180 bpm; null until there are enough. */
export class TempoTracker {
  private onsets: number[] = [];
  push(now: number): void {
    this.onsets.push(now);
    while (this.onsets.length > 12 || (this.onsets.length > 2 && now - (this.onsets[0] ?? now) > 8)) this.onsets.shift();
  }
  bpm(): number | null {
    const iois: number[] = [];
    for (let i = 1; i < this.onsets.length; i++) iois.push((this.onsets[i] ?? 0) - (this.onsets[i - 1] ?? 0));
    const good = iois.filter((x) => x > 0.12 && x < 2).sort((a, b) => a - b);
    if (good.length < 4) return null;
    let bpm = 60 / (good[Math.floor(good.length / 2)] ?? 0.5);
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return bpm;
  }
}

export class VoiceInput {
  onEvent: (e: VoiceEvent) => void = () => undefined;
  onFrame: (f: VoiceFrame) => void = () => undefined;
  analyzer: VoiceAnalyzer | null = null;
  sensitivity = 2;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private timer = 0;

  get running(): boolean {
    return this.timer !== 0;
  }

  async start(): Promise<void> {
    if (this.running) return;
    // Raw signal: echo cancelling, noise suppression and auto gain all smear the pitch and the staccato onsets.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const an = ctx.createAnalyser();
    an.fftSize = ctx.sampleRate > 50000 ? 4096 : 2048;
    an.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(an);
    const az = new VoiceAnalyzer(ctx.sampleRate);
    az.sensitivity = this.sensitivity;
    this.analyzer = az;
    void ctx.resume();
    this.stream = stream;
    this.ctx = ctx;
    const buf = new Float32Array(an.fftSize);
    this.timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      for (const e of az.process(buf, performance.now() / 1000)) this.onEvent(e);
      this.onFrame(az.frame);
    }, 10);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyzer = null;
  }
}
