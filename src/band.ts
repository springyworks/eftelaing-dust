// Jazz band played by the whole brain through a built-in MIDI-style synthesiser.
//
// Layer 1 (index 0, "Physical") is the rhythm section and the foundation; the "brain" share (Params.bandBrain) lets the
// other nine layers join in, so 0 = layer 1 alone and 1 = the complete OSI+ stack:
//   L1 activity (rms)      -> how much is played, velocities
//   L1 centroid x, y       -> walking-bass choice
//   L4 crest factor        -> comping density (peaky tank = more stabs)
//   L7, L8 centroids       -> melody register and direction
//   L10 Director activity  -> tempo (the conductor)
//   alignment + stability  -> brain health: a healthy brain plays tight and in tune, a stressed one gets loose
//   Maslow fulfilment      -> harmony: well-fed levels resolve (Cmaj9, A13), unmet ones stay tense (Cmaj9#11, A7b9b13)
//   dust                   -> loose, human ride timing
//   L2..L10 pitch + spikes -> the choir: every layer is its own MIDI voice (chord tones from its measured pitch) and
//                             speaks up when it spikes; each voice has its own HRTF source at its layer's place
//
// No dice: every decision that used to be random now reads the tanks. q(l) walks through the wave field of layer l and
// squashes the sample to 0..1, so "chance" is the state of the stack. The tune itself is a theme read off the layers:
//   theme A  = a scan line through layer 1's sand bed (the terrain the waves have carved) plus its live wave, eight samples
//              for the eight eighth-notes of a bar, turned into scale steps; B is read the same way from the loudest upper layer
//   rhythm   = the synchroniser: eighth-note slot k of the bar belongs to the phase lock between layers k+1 and k+2. A slot
//              speaks when that pair is more in sync than average
//   form     = A A A A | B B | A A over the eight-bar loop; every odd bar answers with a fresh live reading in its tail
// Notes are plain MIDI events (channel, note, velocity, duration). They drive the internal synthesiser and, optionally,
// a real MIDI output through Web MIDI.

import { NUM_LAYERS, NUM_LEVELS, clamp, type Params } from "./model";
import type { Simulation } from "./sim";

export interface Spat {
  readonly input: AudioNode;
  set(az: number, el: number, r: number, binaural: boolean, reverb: number, now: number): void;
}

interface MidiOut {
  readonly name?: string | null;
  send(data: number[], timestamp?: number): void;
}

interface MidiAccessLike {
  readonly outputs: { values(): Iterable<MidiOut> };
}

interface Chord {
  readonly name: string;
  readonly root: number; // MIDI note of the bass root
  readonly bass: readonly number[]; // chord tones above the root, in semitones
  readonly voicing: readonly number[]; // rootless comping voicing, MIDI notes
  readonly scale: readonly number[]; // pitch classes of the improvisation scale
}

const chord = (name: string, root: number, bass: readonly number[], voicing: readonly number[], scale: readonly number[]): Chord => ({ name, root, bass, voicing, scale });

// Dm11 | G13 | Cmaj9#11 | A7b9b13, two bars each. Low Maslow fulfilment keeps the tense colours, high fulfilment resolves them.
export function progression(tension: number): readonly Chord[] {
  return [
    chord("Dm11", 38, [0, 3, 7, 10], [65, 72, 76, 79], [2, 4, 5, 7, 9, 11, 0]),
    chord("G13", 43, [0, 4, 7, 10], [59, 64, 65, 69], [7, 9, 11, 0, 2, 4, 5]),
    tension < 0.3 ? chord("Cmaj9", 48, [0, 4, 7, 11], [64, 67, 71, 74], [0, 2, 4, 5, 7, 9, 11]) : chord("Cmaj9#11", 48, [0, 4, 7, 11], [64, 71, 74, 78], [0, 2, 4, 6, 7, 9, 11]),
    tension > 0.5 ? chord("A7b9b13", 45, [0, 4, 8, 10], [61, 65, 67, 70], [9, 10, 0, 1, 3, 5, 7]) : chord("A13", 45, [0, 4, 7, 10], [61, 66, 67, 71], [9, 11, 1, 2, 4, 6, 7]),
  ];
}

export interface BandVoice {
  readonly name: string;
  readonly color: string;
  az: number;
  el: number;
  r: number;
  level: number;
}

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const LOOKAHEAD = 0.15;
const CH = { bass: 0, comp: 1, lead: 2, drums: 9 } as const;

interface Features {
  d: number; // activity 0..1 (layer 1, blended with the whole brain)
  crest: number; // 0..1
  cx: number; // bass steering (layer 1)
  cy: number;
  lx: number; // melody steering (layers 7 and 8, blended with layer 1)
  ly: number;
  tension: number; // 1 - mean Maslow fulfilment
  health: number; // 0..1 alignment and stability of the whole brain
  brain: number;
  rms: number[]; // per layer 0..1
}

export interface ScenePos {
  az: number;
  el: number;
  r: number;
}

interface Theme {
  name: string;
  layer: number;
  line: string; // where it was read, for the display
  deg: number[]; // scale steps relative to the anchor, one per eighth-note slot of the bar
  hit: boolean[]; // which slots speak, from the synchroniser
}

const lerp1 = (a: number, b: number, k: number): number => a + (b - a) * k;
const CHOIR_CH = [3, 4, 5, 6, 7, 8, 10, 11, 12] as const; // MIDI channels of L2..L10 (channel 10 is the drums)

export class Band {
  bpm = 92;
  chordIndex = 0;
  chordName = "Dm11";
  midiName = "";
  // Every instrument is its own binaural source with a position of its own (see Hearing.md).
  readonly voices: Record<"bass" | "comp" | "lead" | "ride", BandVoice> = {
    bass: { name: "Bass", color: "#e0b040", az: 0, el: -15, r: 1.3, level: 0 },
    comp: { name: "Keys", color: "#5fd0a0", az: -40, el: 10, r: 2, level: 0 },
    lead: { name: "Lead", color: "#ff7a9a", az: 40, el: 25, r: 2.2, level: 0 },
    ride: { name: "Ride", color: "#9ad0ff", az: 110, el: 30, r: 3, level: 0 },
  };
  private cur: Chord;
  private step = 0;
  private next = 0;
  private lastBass = 38;
  private leadMidi = 69;
  private tension = 0.5;
  private accents: { layer: number; mag: number }[] = [];
  private readonly noise: AudioBuffer;
  private readonly spat: { bass: Spat; comp: Spat; lead: Spat; ride: Spat };
  private sim: Simulation | null = null;
  private qi = 0;
  private themes: { A?: Theme; B?: Theme } = {};
  private answer: Theme | null = null;
  themeInfo = "";
  private readonly choir: Spat[]; // one per layer; index 0 is unused
  private lv = { bass: 1, comp: 1, lead: 1, ride: 1, choir: 0 };
  private pitchHz: ArrayLike<number> = [];
  private midi: MidiOut | null = null;
  private midiAsked = false;
  private midiOn = false;

  constructor(
    private readonly ctx: AudioContext,
    makeSpat: () => Spat,
  ) {
    this.cur = progression(0.5)[0] as Chord;
    this.spat = { bass: makeSpat(), comp: makeSpat(), lead: makeSpat(), ride: makeSpat() };
    this.choir = Array.from({ length: NUM_LAYERS }, () => makeSpat());
    const len = Math.floor(ctx.sampleRate * 1.2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Duration of step s of the swung eighth-note grid. */
  private stepDur(s: number, swing: number): number {
    const beat = 60 / this.bpm;
    return beat * (0.5 + (s % 2 === 0 ? 1 : -1) * (swing / 6));
  }

  /** First swung eighth-note slot at or after `time`; used to quantise the raw FM plucks to the band's grid. */
  nextSlot(time: number, swing: number): number {
    let t = this.next;
    let s = this.step;
    for (let i = 0; i < 24 && t < time - 1e-4; i++) {
      t += this.stepDur(s, swing);
      s++;
    }
    return t;
  }

  /** A spike or fired pulse in a layer: an accented comping stab and ride hit on the next grid slot. */
  accent(layer: number, mag: number): void {
    if (this.accents.length < 8) this.accents.push({ layer, mag });
  }

  update(sim: Simulation, p: Params, now: number, scene: readonly ScenePos[], pitchHz: ArrayLike<number>): void {
    const rms = Array.from({ length: NUM_LAYERS }, (_, l) => clamp((sim.rms[l] ?? 0) / 0.35, 0, 1));
    const brain = p.audioMode === "layer1" ? 0 : p.bandBrain;
    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
    const d = lerp(rms[0] ?? 0, mean(rms), 0.4 * brain);
    let ful = 0;
    for (let m = 0; m < NUM_LEVELS; m++) ful += sim.fulfilment[m] ?? 0;
    this.tension = clamp(1 - ful / NUM_LEVELS, 0, 1);
    let stab = 0;
    for (let l = 0; l < NUM_LAYERS; l++) stab += sim.stability[l] ?? 1;
    const health = clamp(0.5 * sim.alignment + 0.5 * (stab / NUM_LAYERS), 0, 1);
    const cen = (l: number, k: number): number => sim.cen[l * 3 + k] ?? 0.5;
    const cx = cen(0, 0);
    const cy = cen(0, 1);
    const f: Features = {
      d,
      crest: clamp(lerp(sim.crest[0] ?? 1, sim.crest[3] ?? 1, brain) / 3 - 1 / 3, 0, 1),
      cx,
      cy,
      lx: lerp(cx, (cen(6, 0) + cen(7, 0)) / 2, brain),
      ly: lerp(cy, (cen(6, 1) + cen(7, 1)) / 2, brain),
      tension: this.tension,
      health,
      brain,
      rms,
    };
    this.pitchHz = pitchHz;
    this.sim = sim;
    this.lv = { bass: p.bandBass, comp: p.bandKeys, lead: p.bandLead, ride: p.bandDrums, choir: p.bandChoir * brain };
    // Layer 1 pushes the tempo a little; with the brain share up, the Director (L10) conducts it.
    const push = lerp(rms[0] ?? 0, rms[9] ?? 0, 0.6 * brain);
    const target = p.tempo * (0.94 + 0.12 * push);
    this.bpm += (target - this.bpm) * 0.05;

    // Placement: the bass sits close and low in front, the keys on the left, the lead on the right (its height follows
    // the pitch it plays, its azimuth the energy centroid of layer 1), the ride behind the right shoulder.
    const w = 0.4 + p.width * 0.9;
    const bin = p.spatial === "binaural";
    const v = this.voices;
    v.bass.az = (f.cx - 0.5) * 30;
    v.comp.az = -50 * w + (f.cy - 0.5) * 12;
    v.lead.az = 45 * w + (f.lx - 0.5) * 40 * w;
    v.lead.el = clamp((this.leadMidi - 60) * 2 - 10, -10, 55);
    v.ride.az = 120 * (0.4 + 0.6 * w * 0.8);
    for (const k of ["bass", "comp", "lead", "ride"] as const) {
      const vo = v[k];
      vo.level *= 0.9;
      this.spat[k].set(vo.az, vo.el, vo.r, bin, p.reverb, now);
    }

    // The choir voices sit exactly where their layers sit in the scene.
    for (let l = 1; l < NUM_LAYERS; l++) {
      const sv = scene[l];
      if (sv) this.choir[l]?.set(sv.az, sv.el, sv.r, bin, p.reverb, now);
    }

    this.midiOn = p.midiOut === "on";
    if (this.midiOn && !this.midiAsked) void this.openMidi();

    if (this.next < now - 0.1) this.next = now + 0.05; // the tab was hidden: do not play catch-up
    const silent = p.audioMode === "raw";
    while (this.next < now + LOOKAHEAD) {
      const dur = this.stepDur(this.step, p.swing);
      this.play(this.next, dur, p, f, silent);
      this.next += dur;
      this.step++;
    }
  }

  private async openMidi(): Promise<void> {
    this.midiAsked = true;
    try {
      const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MidiAccessLike> };
      if (!nav.requestMIDIAccess) {
        this.midiName = "Web MIDI is not available in this browser";
        return;
      }
      const access = await nav.requestMIDIAccess();
      const out = Array.from(access.outputs.values())[0];
      if (out) {
        this.midi = out;
        this.midiName = out.name ?? "MIDI output";
      } else this.midiName = "no MIDI output found";
    } catch {
      this.midiName = "MIDI access was refused";
    }
  }

  /** A number in 0..1 taken from the wave field of layer l: the state of the stack instead of a dice. */
  private q(l: number): number {
    const sim = this.sim;
    const u = sim?.u[l];
    if (!sim || !u || u.length === 0) return 0.5;
    this.qi = (this.qi + 7919) % u.length;
    const r = (sim.rms[l] ?? 0) * 1.5 + 1e-6;
    return 0.5 + 0.5 * Math.tanh((u[this.qi] ?? 0) / r);
  }

  /** Reads a theme of eight notes and eight rhythm slots off the layers. */
  private readTheme(name: string, layer: number, vertical: boolean): Theme {
    const sim = this.sim;
    const deg: number[] = Array(8).fill(0);
    const hit: boolean[] = Array(8).fill(false);
    if (!sim) return { name, layer, line: "-", deg, hit };
    const nx = sim.nx;
    const ny = sim.ny;
    const bed = sim.bed[layer];
    const u = sim.u[layer];
    const z = Math.round((sim.cen[layer * 3 + 2] ?? 0.5) * (sim.nz - 1));
    const fixed = vertical ? Math.round((sim.cen[layer * 3] ?? 0.5) * (nx - 1)) : Math.round((sim.cen[layer * 3 + 1] ?? 0.5) * (ny - 1));
    const sample = (arr: Float32Array | undefined, off: number, k: number): number => {
      const along = Math.round(((k + 0.5) / 8) * ((vertical ? ny : nx) - 1));
      const x = vertical ? fixed : along;
      const y = vertical ? along : fixed;
      return arr?.[off + y * nx + x] ?? 0;
    };
    const norm = (a: number[]): number[] => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      const peak = Math.max(...a.map((v) => Math.abs(v - m)));
      return peak < 1e-7 ? a.map(() => 0) : a.map((v) => Math.sign(v - m) * Math.sqrt(Math.abs(v - m) / peak));
    };
    const sand = norm(Array.from({ length: 8 }, (_, k) => sample(bed, 0, k)));
    const wave = norm(Array.from({ length: 8 }, (_, k) => sample(u, z * sim.plane, k)));
    for (let k = 0; k < 8; k++) deg[k] = clamp(Math.round(((sand[k] ?? 0) * 0.6 + (wave[k] ?? 0) * 0.4) * 6), -5, 5);
    // The synchroniser: slot k is the phase lock between layers k+1 and k+2.
    const lock = Array.from({ length: 8 }, (_, k) => sim.lock[k] ?? 0);
    const mean = lock.reduce((x, y) => x + y, 0) / 8;
    for (let k = 0; k < 8; k++) hit[k] = k === 0 || (lock[k] ?? 0) >= mean;
    return { name, layer, line: `L${layer + 1} ${vertical ? "column" : "row"} ${fixed}`, deg, hit };
  }

  /** Form over the eight-bar loop: A A A A | B B | A A, with the tail of every odd bar answered by a fresh live reading. */
  private themeFor(bar: number): Theme | undefined {
    const b = bar % 8;
    return b === 4 || b === 5 ? this.themes.B : this.themes.A;
  }

  private prepareBar(bar: number, f: Features): void {
    const b = bar % 8;
    if (b === 0 || !this.themes.A) this.themes.A = this.readTheme("A", 0, false);
    if (b === 4 || !this.themes.B) {
      let lead = 0;
      let best = 0;
      if (f.brain > 0.05) {
        for (let l = 1; l < NUM_LAYERS; l++) {
          const w = (f.rms[l] ?? 0) * f.brain;
          if (w > best) {
            best = w;
            lead = l;
          }
        }
      }
      this.themes.B = this.readTheme("B", lead, lead === 0);
    }
    const th = this.themeFor(bar);
    this.answer = bar % 2 === 1 && th ? this.readTheme(th.name + "'", th.layer, th.layer === 0 && th.name === "B") : null;
    this.themeInfo = `${th?.name ?? "-"}${this.answer ? "'" : ""} (${th?.line ?? "-"}) steps ${th?.deg.join(" ") ?? ""} · sync ${th?.hit.map((h) => (h ? "x" : ".")).join("") ?? ""}`;
  }

  private send(ch: number, note: number, vel: number, t: number, dur: number): void {
    const out = this.midi;
    if (!out || !this.midiOn) return;
    const ms = performance.now() + (t - this.ctx.currentTime) * 1000;
    out.send([0x90 | ch, note, vel], ms);
    out.send([0x80 | ch, note, 0], ms + dur * 1000);
  }

  private play(t: number, stepLen: number, p: Params, f: Features, silent: boolean): void {
    const s = this.step;
    const inChord = s % 16;
    const beat = inChord >> 1;
    const off = (s & 1) === 1;
    const q = beat % 4;
    if (inChord === 0 || s === 0) {
      this.chordIndex = Math.floor(s / 16) % 4;
      this.cur = progression(f.tension)[this.chordIndex] ?? this.cur;
      this.chordName = this.cur.name;
    }
    const accents = this.accents;
    this.accents = [];
    if (silent) return;

    const cur = this.cur;
    const nextChord = progression(f.tension)[(this.chordIndex + 1) % 4] ?? cur;
    const beatDur = 60 / this.bpm;
    const vel = (base: number, span: number): number => Math.round(clamp(base + span * f.d + (this.q(0) - 0.5) * 10, 1, 127));
    const dens = p.bandDensity * 2;
    const loose = (0.3 + p.dust * 3) * 0.012 * (1.7 - f.health);
    const jit = (l: number): number => Math.max(this.ctx.currentTime, t + (this.q(l) - 0.5) * loose);
    const k = s % 8; // slot of the bar

    // Walking bass: one note per beat, always from the bottom layer's activity.
    if (!off && f.d > 0.02) {
      let n: number;
      if (beat === 7) {
        const target = nextChord.root;
        n = Math.abs(target + 1 - this.lastBass) < Math.abs(target - 1 - this.lastBass) ? target + 1 : target - 1;
        if (f.cy > 0.5) n = target + 1;
        else if (f.cy < 0.35) n = target - 1;
      } else if (q === 0) n = cur.root;
      else n = cur.root + (cur.bass[(Math.floor(f.cx * 7) + beat) % cur.bass.length] ?? 0);
      while (n > 55) n -= 12;
      while (n < 28) n += 12;
      this.lastBass = n;
      this.bassNote(t, n, vel(62, 40), beatDur * 0.92);
    }

    // Ride cymbal: quarter notes plus the swung skip beat, loosened by Dust; foot hi-hat on 2 and 4.
    if (f.d > 0.02) {
      const skip = off && (q === 1 || q === 3);
      if ((!off || skip) && this.q(1) > p.dust * 0.5) {
        const v = Math.round(clamp((skip ? 38 : 48) + 26 * f.d + (q === 1 || q === 3 ? 6 : 0) + (this.q(1) - 0.5) * 14 * (0.3 + p.dust * 3), 1, 127));
        this.rideHit(jit(1), v, 0.4);
      }
      if (!off && (q === 1 || q === 3)) this.hatFoot(t, Math.round(30 + 25 * f.d));
    }

    // Comping: the charleston "1" and "and of 2", extra hits by crest factor, and a stab for every accent.
    const lk = this.sim?.lock;
    const sync = lk ? (lk[k] ?? 0) - lk.reduce((x, y) => x + y, 0) / lk.length : 0;
    const compWanted = f.d > 0.05 && ((!off && q === 0 && this.q(3) < 0.5) || (off && q === 1) || (off && sync > 0 && this.q(3) < (0.25 + 0.7 * f.crest) * dens));
    if (compWanted) this.comp(jit(3), cur.voicing, vel(40, 34), beatDur * 0.4, f.crest < 0.3 ? 3 : 4);
    for (const a of accents) {
      const top = cur.voicing.slice(-3).map((n) => n + (a.layer >= 7 ? 12 : 0));
      this.comp(t, top, Math.round(clamp(52 + a.mag * 16, 1, 127)), beatDur * 0.3, 3);
      this.rideHit(t, Math.round(clamp(60 + a.mag * 12, 1, 127)), 0.8);
      if (a.layer === 0) this.bassNote(t, Math.max(28, cur.root - 12 + (cur.bass[2] ?? 0)), 96, beatDur * 0.5);
      else this.choirNote(a.layer, t, this.layerNote(a.layer, cur, f), Math.round(clamp(58 + a.mag * 14, 1, 127)), beatDur * 0.9);
    }

    // Choir: on its own beat of the bar every layer may play a chord tone from its measured pitch.
    if (!off && f.brain > 0) {
      for (let l = 1; l < NUM_LAYERS; l++) {
        if ((beat + l) % 4 !== 0) continue;
        const r = f.rms[l] ?? 0;
        if (this.q(l) > clamp((0.2 + 1.1 * r) * f.brain, 0, 0.95)) continue;
        this.choirNote(l, jit(l), this.layerNote(l, cur, f), Math.round(clamp(28 + 56 * r, 1, 127)), beatDur * 1.6);
      }
    }

    // Melody: the theme of the current bar, read off the layers (see the header), transposed onto the current chord.
    if (k === 0) this.prepareBar(s >> 3, f);
    const th = this.answer && k >= 5 ? this.answer : this.themeFor(s >> 3);
    if (th && f.d > 0.08 && th.hit[k] === true && this.q(2) < clamp(dens * (0.4 + 0.8 * lerp1(f.d, f.rms[k] ?? 0, f.brain)), 0, 1)) {
      const pool: number[] = [];
      for (let m = 58; m <= 88; m++) if (cur.scale.includes(m % 12)) pool.push(m);
      const centre = 64 + f.lx * 16 - (f.ly - 0.5) * 6;
      let idx = 0;
      let bestD = Infinity;
      pool.forEach((m, i) => {
        const dd = Math.abs(m - centre);
        if (dd < bestD) {
          bestD = dd;
          idx = i;
        }
      });
      idx = clamp(idx + (th.deg[k] ?? 0), 0, pool.length - 1);
      let note = pool[idx] ?? this.leadMidi;
      if (!off && q % 2 === 0) {
        const pcs = cur.bass.map((i) => (cur.root + i) % 12);
        let best = note;
        let bd = Infinity;
        for (let m = note - 3; m <= note + 3; m++) {
          if (!pcs.includes(m % 12)) continue;
          const dd = Math.abs(m - note);
          if (dd < bd) {
            bd = dd;
            best = m;
          }
        }
        note = best;
      }
      this.leadMidi = note;
      this.leadNote(t, note, vel(52, 44), stepLen * 0.9);
    }
  }

  /** The note a layer plays: its measured pitch folded into the layer's register, pulled to the chord by brain health. */
  private layerNote(l: number, cur: Chord, f: Features): number {
    const hz = Number(this.pitchHz[l]) || 220;
    let m = 69 + 12 * Math.log2(hz / 440);
    const reg = 58 + (l - 1) * 2.5;
    while (m > reg + 7) m -= 12;
    while (m < reg - 5) m += 12;
    m = Math.round(m);
    const pcs = this.q(l) < 0.55 + 0.45 * f.health ? cur.bass.map((i) => (cur.root + i) % 12) : cur.scale;
    let best = m;
    let bd = Infinity;
    for (let n = m - 6; n <= m + 6; n++) {
      if (!pcs.includes(((n % 12) + 12) % 12)) continue;
      if (Math.abs(n - m) < bd) {
        bd = Math.abs(n - m);
        best = n;
      }
    }
    return best;
  }

  // ---- built-in MIDI-style synthesiser ----

  // Soft FM bell voice of one layer, sounding from the layer's own HRTF source.
  private choirNote(l: number, t: number, midi: number, vel: number, dur: number): void {
    const out = this.choir[l];
    const lv = this.lv.choir;
    vel = Math.round(vel * lv);
    if (!out || vel < 2) return;
    this.send(CHOIR_CH[l - 1] ?? 3, midi, vel, t, dur);
    const ctx = this.ctx;
    const f = mtof(midi);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    const g = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * 2;
    mg.gain.setValueAtTime(f * 0.9, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur);
    const a = (0.13 * vel) / 127;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.4);
    mod.connect(mg).connect(car.frequency);
    car.connect(g).connect(out.input);
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.45);
    mod.stop(t + dur + 0.45);
  }

  private bassNote(t: number, midi: number, vel: number, dur: number): void {
    vel = Math.round(vel * this.lv.bass);
    if (vel < 2) return;
    this.send(CH.bass, midi, vel, t, dur);
    this.voices.bass.level = Math.max(this.voices.bass.level, vel / 127);
    const ctx = this.ctx;
    const f = mtof(midi);
    const a = (0.55 * vel) / 127;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + 0.008);
    g.gain.exponentialRampToValueAtTime(Math.max(a * 0.35, 0.0002), t + dur * 0.9);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.06);
    for (const type of ["triangle", "sine"] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.08);
    }
    lp.connect(g).connect(this.spat.bass.input);
  }

  // Electric-piano style FM voices.
  private comp(t: number, notes: readonly number[], vel: number, dur: number, count: number): void {
    vel = Math.round(vel * this.lv.comp);
    if (vel < 2) return;
    const ctx = this.ctx;
    notes.slice(0, count).forEach((midi, i) => {
      const tt = t + i * 0.007;
      this.send(CH.comp, midi, vel, tt, dur);
      this.voices.comp.level = Math.max(this.voices.comp.level, vel / 127);
      const f = mtof(midi);
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const mg = ctx.createGain();
      const g = ctx.createGain();
      car.frequency.value = f;
      mod.frequency.value = f;
      const index = (1.2 + (vel / 127) * 1.6) * f;
      mg.gain.setValueAtTime(index, tt);
      mg.gain.exponentialRampToValueAtTime(0.25 * f, tt + 0.5);
      const a = (0.2 * vel) / 127 / Math.sqrt(count);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(a, tt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0005, tt + 0.9);
      mod.connect(mg).connect(car.frequency);
      car.connect(g).connect(this.spat.comp.input);
      car.start(tt);
      mod.start(tt);
      car.stop(tt + 0.95);
      mod.stop(tt + 0.95);
    });
  }

  private leadNote(t: number, midi: number, vel: number, dur: number): void {
    vel = Math.round(vel * this.lv.lead);
    if (vel < 2) return;
    this.send(CH.lead, midi, vel, t, dur);
    this.voices.lead.level = Math.max(this.voices.lead.level, vel / 127);
    const ctx = this.ctx;
    const f = mtof(midi);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 5.5;
    lg.gain.value = 10;
    lfo.connect(lg).connect(o.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(900 + vel * 14, t);
    lp.frequency.exponentialRampToValueAtTime(500 + vel * 4, t + dur);
    const g = ctx.createGain();
    const a = (0.16 * vel) / 127;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + 0.015);
    g.gain.setValueAtTime(a * 0.8, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
    o.connect(lp).connect(g).connect(this.spat.lead.input);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.06);
    lfo.stop(t + dur + 0.06);
  }

  private noiseBurst(t: number, dest: AudioNode, hp: number, peak: number, decay: number, band?: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hi = ctx.createBiquadFilter();
    hi.type = "highpass";
    hi.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    src.connect(hi);
    if (band) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = band;
      bp.Q.value = 0.8;
      hi.connect(bp).connect(g);
    } else hi.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.1);
    src.stop(t + decay + 0.02);
  }

  private rideHit(t: number, vel: number, decayScale: number): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    this.send(CH.drums, 51, vel, t, 0.3);
    this.voices.ride.level = Math.max(this.voices.ride.level, vel / 127);
    const peak = (0.3 * vel) / 127;
    this.noiseBurst(t, this.spat.ride.input, 5000, peak, 0.45 * decayScale + 0.1, 8500);
    const ctx = this.ctx;
    const ping = ctx.createOscillator();
    const g = ctx.createGain();
    ping.frequency.value = 5200;
    g.gain.setValueAtTime(peak * 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    ping.connect(g).connect(this.spat.ride.input);
    ping.start(t);
    ping.stop(t + 0.2);
  }

  private hatFoot(t: number, vel: number): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    this.send(CH.drums, 44, vel, t, 0.1);
    this.noiseBurst(t, this.spat.ride.input, 7000, (0.22 * vel) / 127, 0.07);
  }
}
