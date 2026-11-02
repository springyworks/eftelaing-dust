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

import { NUM_LAYERS, NUM_LEVELS, clamp, type BandStyle, type Params } from "./model";
import type { Simulation } from "./sim";
import { BOSSA_CLAVE, BOSSA_KICK, CHICKEN, FUNK_BASS, GHOST_SLOTS, KICKS, Personality, STRUMS, STYLES, STYLE_IDS, SWING_COMP, progressionCount, progressionOf, type Chord, type StyleId } from "./style";
import { GUITAR_VOICING, VOICING_NAMES, harmonicHeat, planChord, voiceLead } from "./harmony";

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

export interface BandVoice {
  name: string;
  readonly color: string;
  az: number;
  el: number;
  r: number;
  level: number;
}

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const LOOKAHEAD = 0.15;
const CH = { bass: 0, comp: 1, lead: 2, drums: 9 } as const;

// Instrument patches. Which one sounds is read from the layers (see Band.sig), not chosen by hand; gm is the General MIDI
// program sent with a program change when a patch is swapped, so an external synth changes instrument too.
interface Patch {
  name: string;
  gm: number;
}
const BASS_PATCHES: readonly Patch[] = [
  { name: "upright", gm: 32 },
  { name: "fretless", gm: 35 },
  { name: "synth bass", gm: 38 },
  { name: "sub", gm: 39 },
];
const KEYS_PATCHES: readonly Patch[] = [
  { name: "e-piano", gm: 4 },
  { name: "vibes", gm: 11 },
  { name: "organ", gm: 16 },
  { name: "harp", gm: 46 },
  { name: "warm pad", gm: 89 },
  { name: "strum guitar", gm: 25 },
];
const GUITAR_PATCH = 5;
const LEAD_PATCHES: readonly Patch[] = [
  { name: "saw lead", gm: 81 },
  { name: "flute", gm: 73 },
  { name: "muted trumpet", gm: 59 },
  { name: "clarinet", gm: 71 },
];
const RIDE_PATCHES: readonly Patch[] = [
  { name: "ride", gm: 51 },
  { name: "brushes", gm: 40 },
  { name: "hat", gm: 42 },
];
// Choir voices are FM bells whose modulator ratio comes from the layer's own signature.
const CHOIR_PATCHES: readonly { name: string; ratio: number; gm: number }[] = [
  { name: "bell", ratio: 2, gm: 14 },
  { name: "glass", ratio: 3.5, gm: 98 },
  { name: "marimba", ratio: 1, gm: 12 },
  { name: "celesta", ratio: 4, gm: 8 },
  { name: "tine", ratio: 1.5, gm: 10 },
];

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

// One note of a lead phrase: i = sixteenth of the bar (0..15), v = velocity offset, len in sixteenths.
interface Note16 {
  i: number;
  n: number;
  v: number;
  len: number;
  /** An ornament (mordent, trill) that replaces the plain note: pitch, start and length in sixteenths. */
  orn?: readonly { n: number; at: number; len: number }[];
}

const lerp1 = (a: number, b: number, k: number): number => a + (b - a) * k;
type VoiceKey = "bass" | "comp" | "lead" | "ride";
const HANDOVER_SLOTS = 16; // two bars
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
  private readonly beats: { t: number; n: number }[] = [];
  private lastBass = 38;
  private bassPush: number | null = null;
  private fillRolled = false;
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
  // Current instrument per voice and the layer each was read from. A swap is a slow handover (prev fades out while cur
  // fades in, x runs 0..1), never a hard cut; `last` is the bar of the previous swap.
  private patch = { bass: 0, comp: 0, lead: 0, ride: 0 };
  private patchLayer = { bass: 0, comp: 3, lead: 0, ride: 5 };
  private ho: Record<VoiceKey, { prev: number; x: number; last: number }> = {
    bass: { prev: 0, x: 1, last: -99 },
    comp: { prev: 0, x: 1, last: -99 },
    lead: { prev: 0, x: 1, last: -99 },
    ride: { prev: 0, x: 1, last: -99 },
  };
  private feel = { variation: 0.5, human: 0.5, switchRate: 0.5 };
  private opts = { riffs: 0.6, groove: 0.6, learn: 0.5, evolve: 0.5, style: "auto" as BandStyle };
  // The brain's personality (persistent) and the style it is playing; see style.ts.
  readonly brain = new Personality();
  style: StyleId = "swing";
  swingNow = 0.5; // effective swing of the grid: style x skill + the swing slider
  snapTones: number[] = [0, 2, 5, 7, 9]; // chord tones in semitones above D, for the raw FM voices
  styleInfo = "";
  phraseInfo = "";
  private prog = 0;
  private styleSince = -99;
  private lastPlayed: Record<StyleId, number> = { swing: -99, bebop: -99, fusion: -99, funk: -99, bossa: -99, baroque: -99 };
  private fluent = 0.4;
  private phrase: Note16[] = [];
  private prevPhrase: Note16[] = [];
  private riff: { rhythm: number; pat: string; steps: number[]; left: number } | null = null;
  private curRun: string | null = null;
  private answers = 0;
  private runHist: string[] = [];
  private lastRun: { notes: Note16[]; pool: number[]; left: number } | null = null;
  private l6prev = 0;
  private bassPat = 0;
  private compPat = 0;
  private swcPat = 0;
  private strumPat = 0;
  // Chord voicings: the one in use (voice-led from the last), the guitar shape, the approach chord of the last two beats.
  private vox: number[] = [];
  private strumVox: number[] = [];
  private apprVox: number[] = [];
  private apprStrum: number[] = [];
  private approach: Chord | null = null;
  private lastVariant = -1;
  private heat = 0;
  harmonyInfo = "";
  harmonyNow = "";
  private kickPat = 0;
  // Smoothed loudness of every voice, so the exerciser can tell which one dominates the mix.
  private readonly loud: Record<VoiceKey | "choir", number> = { bass: 0, comp: 0, lead: 0, ride: 0, choir: 0 };
  private choirRatio: number[] = Array.from({ length: NUM_LAYERS }, () => 2);
  private choirPatch: number[] = Array.from({ length: NUM_LAYERS }, () => 0);
  private choirSent: number[] = Array.from({ length: NUM_LAYERS }, () => -1);
  private brainNow = 1;
  patchInfo = "";
  // Characters typed into layer 1, and the brain's answers queued for later grid slots.
  private typed: { code: number }[] = [];
  private echoes: { step: number; kind: "layer" | "stab"; code: number; midi?: number }[] = [];
  // Notes sung into the microphone that the brain has not answered yet.
  private sung: number[] = [];
  echoInfo = "";
  private pitchHz: ArrayLike<number> = [];
  private midi: MidiOut | null = null;
  private midiAsked = false;
  private midiOn = false;

  constructor(
    private readonly ctx: AudioContext,
    makeSpat: () => Spat,
  ) {
    this.cur = progressionOf("swing", 0, 0.5)[0] as Chord;
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

  /** Where the (audible) grid is at `time`: phase in the beat (0..1), beat in the bar (0..3) and the bar counter; null when stopped. */
  beatAt(time: number): { phase: number; beat: number; bar: number } | null {
    let i = this.beats.length - 1;
    while (i >= 0 && (this.beats[i]?.t ?? Infinity) > time) i--;
    const a = this.beats[i];
    if (!a || time - a.t > 1.5) return null;
    const b = this.beats[i + 1];
    const dur = b ? b.t - a.t : 60 / this.bpm;
    return { phase: clamp((time - a.t) / dur, 0, 1), beat: a.n & 3, bar: a.n >> 2 };
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
    this.tension = clamp(1 - ful / NUM_LEVELS + (p.bandColor - 0.5), 0, 1);
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
    this.feel = { variation: p.bandVariation, human: p.bandHuman, switchRate: p.bandSwitch };
    this.opts = { riffs: p.bandRiffs, groove: p.bandGroove, learn: p.bandLearn, evolve: p.bandEvolve, style: p.bandStyle };
    this.fluent = this.brain.fluency(this.style);
    // The swing slider shifts the style's own feel; a young brain swings shallowly, a practised one in full triplets.
    this.swingNow = clamp(STYLES[this.style].swing * (0.55 + 0.45 * this.fluent) + (p.swing - 0.5) * 0.5, 0, 1);
    for (const k of Object.keys(this.loud) as (keyof typeof this.loud)[]) this.loud[k] *= 0.992;
    // Layer 1 pushes the tempo a little; with the brain share up, the Director (L10) conducts it.
    const push = lerp(rms[0] ?? 0, rms[9] ?? 0, 0.6 * brain);
    const target = Math.min(210, p.tempo * STYLES[this.style].tempo * (0.94 + 0.12 * push));
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
      const dur = this.stepDur(this.step, this.swingNow);
      if ((this.step & 1) === 0) {
        this.beats.push({ t: this.next, n: this.step >> 1 });
        if (this.beats.length > 16) this.beats.shift();
      }
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
    l %= NUM_LAYERS; // dice numbers above the last layer wrap round to the lower tanks
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

  /** A character typed into layer 1: the band plays it on the next grid slot and the brain answers a few slots later. */
  type(code: number): void {
    if (this.typed.length < 16) this.typed.push({ code });
  }

  /** The human voice as a note (voice2midi): played at once on the lead when `monitor` is set, and answered by the brain a few grid slots later. */
  /** The chord that is playing now (for the voice auto-tuner). */
  chordNow(): Chord {
    return this.cur;
  }

  voiceNote(midi: number, vel: number, monitor: boolean): void {
    if (monitor) this.leadNote(this.ctx.currentTime + 0.01, midi, vel, 0.5);
    if (this.sung.length < 8) this.sung.push(midi);
  }

  /** An unpitched burst of the voice ("pfff", "tss", "k"): a drum stick, played at once, brighter bursts are higher and drier. */
  voiceHit(vel: number, bright: number): void {
    const t = this.ctx.currentTime + 0.005;
    vel = Math.round(vel * Math.max(this.lv.ride, 0.5));
    this.send(CH.drums, 37, vel, t, 0.08);
    this.heard("ride", vel, 0.3);
    const dest = this.spat.ride.input;
    this.noiseBurst(t, dest, 3200 + 3000 * bright, (0.34 * vel) / 127, 0.025);
    this.noiseBurst(t, dest, 900, (0.22 * vel) / 127, 0.05, 1500 + 1800 * bright);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(1100 + 900 * bright, t);
    o.frequency.exponentialRampToValueAtTime(700 + 400 * bright, t + 0.03);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((0.2 * vel) / 127, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.045);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.06);
  }

  /**
   * Timbre signature of a layer, 0..1, read from its own field: where its energy sits (centroid x), how peaky it is (crest)
   * and how locked it is to its neighbours. The instrument a voice plays is the signature of the layer that drives it.
   */
  private sig(l: number): number {
    const s = this.sim;
    if (!s) return 0.5;
    const peak = clamp(((s.crest[l] ?? 1) - 1) / 2.5, 0, 1);
    const cx = s.cen[l * 3] ?? 0.5;
    const lk = Math.max(s.lock[l] ?? 0, l > 0 ? s.lock[l - 1] ?? 0 : 0);
    // Wrapped (fractional) so small field differences reach every patch instead of saturating at one end.
    const v = cx * 5.3 + peak * 3.1 + lk * 2.3 + l * 0.21;
    return clamp(v - Math.floor(v), 0, 0.999);
  }

  /** With little brain share every voice is read from layer 1 alone. */
  private src(l: number): number {
    return this.brainNow < 0.3 ? 0 : l;
  }

  /**
   * A musician swaps instruments between phrases, one at a time, and lets the old sound die away while the new one comes
   * in. The target is read from the driving layer; it only counts when the signature lies clearly inside another patch
   * (no flicker at a border), enough bars have passed since the last swap (Instrument changes slider) and, if the voice is
   * being played, the swap starts as a two-bar crossfade. A silent voice swaps at once.
   */
  private setPatch(key: VoiceKey, layer: number, bar: number): void {
    const table = key === "bass" ? BASS_PATCHES : key === "comp" ? KEYS_PATCHES : key === "lead" ? LEAD_PATCHES : RIDE_PATCHES;
    const l = this.src(layer);
    this.patchLayer[key] = l;
    const first = this.ho[key].last < -50;
    const s = this.sig(l) * table.length;
    let idx = Math.floor(s);
    const frac = s - idx;
    const cur = this.patch[key];
    if (!first && idx !== cur && (frac < 0.2 || frac > 0.8)) idx = cur;
    const h = this.ho[key];
    const gap = Math.round(24 * (1 - this.feel.switchRate));
    const allowed = this.feel.switchRate > 0.02 && bar - h.last >= gap;
    const quiet = this.lv[key] < 0.05;
    if (idx !== cur && (first || quiet || allowed)) {
      h.prev = cur;
      h.x = first || quiet ? 1 : 0;
      h.last = bar;
      this.patch[key] = idx;
      if (h.x >= 1 && key !== "ride") this.program(CH[key], table[idx]?.gm ?? 0);
    } else if (first) h.last = bar;
    const label = { bass: "Bass", comp: "Keys", lead: "Lead", ride: "Ride" }[key];
    this.voices[key].name = `${label} · ${table[this.patch[key]]?.name ?? ""}`;
  }

  /** The patches sounding for a voice right now with their gains: one, or two during a handover (equal power). */
  private mix(key: VoiceKey): readonly (readonly [number, number])[] {
    const h = this.ho[key];
    const cur = this.patch[key];
    if (h.x >= 1) return [[cur, 1]];
    const a = h.x * Math.PI * 0.5;
    return [
      [h.prev, Math.cos(a)],
      [cur, Math.sin(a)],
    ];
  }

  /** Remembers how loud a voice really is (its gain scale is folded in) for dominant() / quietest(). */
  private heard(key: VoiceKey | "choir", vel: number, gain: number): void {
    this.loud[key] = Math.max(this.loud[key], (vel / 127) * gain);
  }

  /** Name of the slider of the voice that currently dominates the mix, and of the one that is most buried. */
  dominant(): { loud: string; quiet: string } {
    const names = { bass: "bandBass", comp: "bandKeys", lead: "bandLead", ride: "bandDrums", choir: "bandChoir" } as const;
    const ks = Object.keys(names) as (keyof typeof names)[];
    let hi = ks[0] as keyof typeof names;
    let lo = hi;
    for (const k of ks) {
      if (this.loud[k] > this.loud[hi]) hi = k;
      if (this.loud[k] < this.loud[lo]) lo = k;
    }
    return { loud: names[hi], quiet: names[lo] };
  }

  private program(ch: number, gm: number): void {
    const out = this.midi;
    if (out && this.midiOn) out.send([0xc0 | ch, gm]);
  }

  private describePatches(): void {
    const nm = (t: readonly Patch[], i: number): string => t[i]?.name ?? "";
    const L = (l: number): string => `L${l + 1}`;
    const pl = this.patchLayer;
    const one = (key: VoiceKey, t: readonly Patch[]): string => {
      const h = this.ho[key];
      const to = nm(t, this.patch[key]);
      return h.x < 1 ? `${nm(t, h.prev)}→${to} ${Math.round(h.x * 100)}%` : to;
    };
    this.patchInfo = `bass ${one("bass", BASS_PATCHES)} (${L(pl.bass)}) · keys ${one("comp", KEYS_PATCHES)} (${L(pl.comp)}) · lead ${one("lead", LEAD_PATCHES)} (${L(pl.lead)}) · ride ${one("ride", RIDE_PATCHES)} (${L(pl.ride)})`;
  }

  private prepareBar(bar: number, f: Features, silent: boolean): void {
    const b = bar % 8;
    this.brainNow = f.brain;
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
    // One voice changes instrument at a time, at different bars of the eight-bar form (and each swap is a slow handover).
    const th = this.themeFor(bar);
    if (bar === 0 || this.ho.bass.last < -50) {
      this.setPatch("bass", 0, bar);
      this.setPatch("comp", 3, bar);
      this.setPatch("ride", 5, bar);
      this.setPatch("lead", th?.layer ?? 0, bar);
    }
    if (b === 2) this.setPatch("bass", 0, bar);
    if (b === 6) this.setPatch("comp", 3, bar);
    if (b === 3) this.setPatch("ride", 5, bar);
    if (b === 0 || b === 4) this.setPatch("lead", th?.layer ?? 0, bar);
    this.describePatches();
    const answerOdds = clamp(0.25 + 1.5 * this.feel.variation, 0, 1);
    this.answer = bar % 2 === 1 && th && this.q(2) < answerOdds ? this.readTheme(th.name + "'", th.layer, th.layer === 0 && th.name === "B") : null;
    this.themeInfo = `${th?.name ?? "-"}${this.answer ? "'" : ""} (${th?.line ?? "-"}) steps ${th?.deg.join(" ") ?? ""} · sync ${th?.hit.map((h) => (h ? "x" : ".")).join("") ?? ""}`;

    this.lastPlayed[this.style] = bar;
    if (!silent) {
      const lock = this.sim?.lock;
      const groove = lock ? lock.reduce((a, b) => a + b, 0) / Math.max(1, lock.length) : 0;
      this.brain.practise(this.style, groove, f.health, this.opts.learn * 2, (4 * 60) / this.bpm);
    }
    if (bar % 2 === 0) {
      this.bassPat = this.brain.pick("bass:", FUNK_BASS.length, this.q(3));
      this.compPat = this.brain.pick("comp:", CHICKEN.length, this.q(4));
      this.swcPat = this.brain.pick("swc:", SWING_COMP.length, this.q(4));
      this.strumPat = this.brain.pick("strum:", STRUMS.length, this.q(4));
      this.kickPat = this.brain.pick("kick:", KICKS.length, this.q(5));
    }
    this.prevPhrase = this.phrase;
    this.phrase = silent ? [] : this.makePhrase(bar, f, th);
    if (!silent && bar % 4 === 0 && (this.q(12) + this.answers * 0.382) % 1 < 0.4 * this.opts.evolve) {
      // the dice are the stack's, shifted by a counter so that a slow field cannot pin the same mutation; a failed child is retried
      for (let a = 0; a < 5; a++) {
        this.answers += 1;
        const j = this.answers * 0.618;
        if (this.brain.evolve(this.opts.evolve, (this.q(13) + j) % 1, (this.q(14) + j * 1.7) % 1, (this.q(15) + j * 2.3) % 1)) break;
      }
    }
    const st = STYLES[this.style];
    this.styleInfo = `${st.name} (${this.opts.style === "auto" ? "the brain's pick" : "locked"}) · progression ${this.prog + 1}/${progressionCount(this.style)} · swing ${Math.round(this.swingNow * 100)}% · ${Math.round(this.bpm)} bpm`;
  }

  /** What the brain has become so far: stage, swing skill, lick vocabulary, mastery of the current style, what you liked. */
  get personalityInfo(): string {
    return this.brain.describe(this.style);
  }

  /** A rating from the human (and the hint chips ticked with it) about what is playing right now. */
  teach(rating: number, hints: readonly string[]): void {
    this.brain.teach(this.style, rating, hints, this.opts.learn * 2);
  }

  private bestStyle(bar: number, f: Features): StyleId {
    const upper = f.rms.slice(3).reduce((a, b) => a + b, 0) / Math.max(1, f.rms.length - 3);
    const raw: Record<StyleId, number> = {
      swing: 0.8 - Math.abs(f.d - 0.4), // the human asked for jazz, so jazz is the home style
      bebop: 0.35 + 0.7 * f.d + 0.2 * f.health,
      fusion: 0.15 + 0.6 * upper + 0.3 * f.tension,
      funk: 0.1 + 0.8 * f.crest + 0.2 * f.d,
      bossa: 0.2 + 0.6 * (1 - f.d) + 0.2 * f.health,
      baroque: 0.15 + 0.5 * f.health * (1 - f.crest) + 0.2 * f.d,
    };
    let best = this.style;
    let top = -Infinity;
    STYLE_IDS.forEach((s, i) => {
      if (s === this.style && this.brain.restless) return;
      const novelty = clamp((bar - this.lastPlayed[s]) / 80, 0, 1) * 0.25;
      const score = raw[s] + 0.45 * this.brain.liking[s] + novelty + 0.12 * (this.q(i + 3) - 0.5) + (s === this.style ? 0.08 : 0);
      if (score > top) {
        top = score;
        best = s;
      }
    });
    return best;
  }

  /**
   * The style comes from the layers (activity, peakiness, tension, upper-layer energy) weighed with what the human liked
   * before and a taste for novelty, or from the style selector. It only changes at chord boundaries; in auto mode the
   * brain reconsiders every eight bars and stays at least sixteen, unless asked ("Same old tune", "Want funk").
   */
  private chooseStyle(bar: number, f: Features): void {
    const sel = this.opts.style;
    const first = this.styleSince < -50;
    const even = bar % 2 === 0;
    let next = this.style;
    if (sel !== "auto") {
      this.brain.wanted = null;
      if (first || even) next = sel;
    } else if (this.brain.wanted && even) {
      next = this.brain.wanted;
      this.brain.wanted = null;
    } else if (first || (bar % 8 === 0 && (bar - this.styleSince >= 16 || this.brain.restless))) {
      next = this.bestStyle(bar, f);
    }
    if (next !== this.style || first) {
      this.style = next;
      this.styleSince = bar;
      this.prog = this.brain.pick(`prog:${next}:`, progressionCount(next), this.q(8));
      this.brain.restless = false;
      this.riff = null;
    } else if (bar % 16 === 0 && bar > 0) {
      const n = progressionCount(this.style);
      let p = this.brain.pick(`prog:${this.style}:`, n, this.q(8));
      if (p === this.prog && n > 1 && (this.brain.restless || (this.brain.taste[`prog:${this.style}:${p}`] ?? 0) <= 0)) p = (p + 1) % n;
      this.prog = p;
      this.brain.restless = false;
    }
  }

  /** The names of the patterns that sound right now: what a "nice" or "try again" refers to. */
  private playingKeys(): string[] {
    const st = STYLES[this.style];
    const keys = [`prog:${this.style}:${this.prog}`];
    if (st.bass === "funk") keys.push(`bass:${this.bassPat}`);
    if (this.patch.comp === GUITAR_PATCH) keys.push(`strum:${this.strumPat}`);
    else if (st.comp === "chicken") keys.push(`comp:${this.compPat}`);
    else if (st.comp === "charleston") keys.push(`swc:${this.swcPat}`);
    if (st.drums !== "swing" && st.drums !== "bossa" && st.drums !== "none") keys.push(`kick:${this.kickPat}`);
    if (this.curRun && this.phrase.length > 0) keys.push(`run:${this.curRun}`);
    if (this.riff && this.phrase.length > 0 && !this.curRun && (st.lead === "funk" || st.lead === "fusion")) keys.push(`riff:${this.riff.rhythm}`);
    return keys;
  }

  /** Sugar for the brain: "nice" (positive) or "try again" (not nice, never a punishment) for what plays right now. */
  encourage(nice: boolean, amount: number): void {
    const keys = this.playingKeys();
    if (nice) this.brain.reward(this.style, amount, keys, this.opts.learn * 2);
    else this.brain.retry(this.style, amount, keys, this.opts.learn * 2);
  }

  private lastScratch = 0;

  /**
   * A finger in the sand or water of tank `l` (0..9): x (0..1) picks a note of the current scale, y and the finger speed give
   * its loudness, and the tank plays it with its own voice (layer 1: the lead, the others: their choir voice), plus a dry
   * rasp of sand. It goes out over MIDI like every other note, so an external synth plays along.
   */
  scratch(l: number, x: number, y: number, speed: number): void {
    const now = this.ctx.currentTime;
    if (now - this.lastScratch < 0.09 - 0.04 * clamp(speed, 0, 1)) return;
    this.lastScratch = now;
    const pool = this.poolOf(this.cur.scale, 50 + l, 86);
    const note = pool[clamp(Math.floor(clamp(x, 0, 0.999) * pool.length), 0, pool.length - 1)] ?? 69;
    const vel = Math.round(clamp(40 + 50 * clamp(speed, 0, 1) + 20 * (1 - clamp(y, 0, 1)), 20, 118));
    const t = now + 0.01;
    if (l === 0 || this.lv.choir < 0.05) this.leadNote(t, note, vel, 0.22);
    else this.choirNote(l, t, note, vel, 0.3);
    this.noiseBurst(t, this.spat.ride.input, 2200 + 2000 * clamp(speed, 0, 1), 0.05 * (vel / 127), 0.05, 3000);
    this.brain.watch();
  }

  private poolOf(pcs: readonly number[], lo = 54, hi = 92): number[] {
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (pcs.includes(m % 12)) out.push(m);
    return out;
  }

  private nearest(pool: readonly number[], m: number): number {
    let idx = 0;
    let bd = Infinity;
    pool.forEach((x, i) => {
      const dd = Math.abs(x - m);
      if (dd < bd) {
        bd = dd;
        idx = i;
      }
    });
    return idx;
  }

  private snapChord(m: number, c: Chord): number {
    const pcs = c.bass.map((i) => (c.root + i) % 12);
    let best = m;
    let bd = Infinity;
    for (let n = m - 3; n <= m + 3; n++) {
      if (!pcs.includes(n % 12)) continue;
      if (Math.abs(n - m) < bd) {
        bd = Math.abs(n - m);
        best = n;
      }
    }
    return best;
  }

  private static readonly RUN_KINDS = ["scale run", "arpeggio", "chromatic run", "zigzag", "cells 1-2-3-5", "cells 1-3-2-4", "cells 4-3-2-1", "scale and turn"] as const;
  private static readonly CELLS: Record<string, readonly number[]> = {
    "cells 1-2-3-5": [0, 1, 2, 4],
    "cells 1-3-2-4": [0, 2, 1, 3],
    "cells 4-3-2-1": [3, 2, 1, 0],
  };

  /** Picks a kind of run: liked ones more often, and never the same as the last one or two. */
  private pickRunKind(): string {
    const kinds = Band.RUN_KINDS;
    const w = kinds.map((k) => {
      let x = Math.exp(1.6 * (this.brain.taste[`run:${k}`] ?? 0));
      const last = this.runHist.lastIndexOf(k);
      if (last === this.runHist.length - 1) x *= 0.1;
      else if (last >= 0) x *= 0.45;
      return x;
    });
    this.answers += 1;
    let x = ((this.q(15) + this.answers * 0.618) % 1) * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < kinds.length; i++) {
      x -= w[i] ?? 0;
      if (x < 0) return kinds[i] ?? "scale run";
    }
    return "scale run";
  }

  /**
   * A running line: a scale run, an arpeggio through the chord, a chromatic run that lands on a tone of the next chord, a
   * zigzag, or one of the digital cells jazz players practise (1-2-3-5, 1-3-2-4, 4-3-2-1) moved along the scale. Direction
   * follows the theme and whether layer 6 (Presentation) is growing or fading; the start slot, the length and the holes come
   * from the layers; the line breathes (a rest at the end, the last note held) and swells in the middle.
   */
  private makeRun(f: Features, th: Theme | undefined, cur: Chord, next: Chord, centre: number, eighths: boolean, odd: boolean): Note16[] {
    const fl = this.fluent;
    const stride = eighths ? 2 : 1;
    const kind = this.pickRunKind();
    const deg = th?.deg ?? [];
    const l6 = f.rms[5] ?? 0;
    const rising = l6 > this.l6prev;
    this.l6prev = this.l6prev * 0.7 + l6 * 0.3;
    let dir = this.q(3) < 0.65 ? (rising ? 1 : -1) : (deg[4] ?? 0) >= (deg[0] ?? 0) ? 1 : -1;
    const start = [0, 0, 2, 4][Math.floor(this.q(4) * 3.99)] ?? 0;
    const slots = Math.floor((16 - start) / stride) - 1;
    const len = clamp(Math.round(5 + (3 + 6 * fl) * this.q(5)), 5, Math.max(5, slots));
    const scale = this.poolOf(cur.scale, 52, 90);
    const tones = this.poolOf(cur.bass.map((i) => (cur.root + i) % 12), 50, 92);
    const idxs: number[] = [];
    const midis: number[] = [];
    let pool = scale;
    let idx = this.nearest(scale, centre + (dir > 0 ? -4 : 4));
    if (kind === "arpeggio") {
      pool = tones;
      idx = this.nearest(tones, centre + (dir > 0 ? -5 : 5));
    }
    const cell = Band.CELLS[kind];
    for (let j = 0; j < len; j++) {
      let at: number;
      if (cell) {
        const g = Math.floor(j / 4);
        at = idx + dir * g + (cell[j % 4] ?? 0);
        if (g > 0 && j % 4 === 0 && this.q(6) < 0.2) dir = -dir;
      } else if (kind === "zigzag") {
        at = idx;
        idx += j % 2 === 0 ? 2 * dir : -dir;
      } else if (kind === "scale and turn") {
        at = idx + (j % 4 === 3 ? -dir : 0);
        if (j % 4 !== 3) idx += dir;
      } else {
        at = idx;
        idx += dir;
        if (this.q(7) < 0.1 + 0.08 * (1 - fl) * (j > 3 ? 1 : 0)) dir = -dir;
      }
      if (at <= 0 || at >= pool.length - 1) {
        dir = -dir;
        idx = clamp(idx, 1, pool.length - 2);
        at = clamp(at, 0, pool.length - 1);
      }
      idxs.push(at);
      midis.push(pool[clamp(at, 0, pool.length - 1)] ?? 69);
    }
    if (kind === "chromatic run" && midis.length >= 4) {
      const target = this.snapChord(midis[midis.length - 1] ?? 69, next);
      const from = dir > 0 ? -3 : 3;
      for (let k = 0; k < 4; k++) midis[midis.length - 4 + k] = target + from - Math.sign(from) * k;
    } else if (odd && this.q(8) < 0.3 + 0.5 * fl && midis.length >= 3) {
      // an enclosure of a chord tone of the next chord, as in bebop
      const target = this.snapChord(midis[midis.length - 1] ?? 69, next);
      midis[midis.length - 3] = target + 2;
      midis[midis.length - 2] = target - 1;
      midis[midis.length - 1] = target;
    }
    const out: Note16[] = [];
    midis.forEach((n, j) => {
      if (j > 0 && j < len - 1 && this.q(9) < 0.07 * (1.4 - fl)) return; // a hole: nobody plays every note
      const arc = Math.round(7 * Math.sin((Math.PI * (j + 0.5)) / len));
      out.push({ i: start + j * stride, n, v: arc - 3 + (j % 4 === 0 ? 3 : 0), len: j === len - 1 ? stride * 2 : stride });
    });
    this.curRun = kind;
    this.runHist = [...this.runHist.slice(-3), kind];
    this.lastRun = { notes: out, pool, left: 1 };
    this.phraseInfo = `${kind}, ${out.length} notes ${dir > 0 ? "up" : "down"}${rising ? " (L6 swelling)" : " (L6 fading)"}${this.brain.generation ? ` · gen ${this.brain.generation}` : ""}`;
    return out;
  }

  /** Call and response: the last run answered by its inversion, its retrograde or itself a step higher or lower. */
  private developRun(prev: { notes: Note16[]; pool: number[] }, next: Chord): Note16[] {
    const pool = prev.pool;
    if (prev.notes.length < 3 || pool.length < 4) return [];
    this.answers += 1;
    const op = Math.floor(((this.q(10) + this.answers * 0.618) % 1) * 3); // the field moves slowly; the counter keeps the answers from sticking to one device
    const first = prev.notes[0]?.n ?? 69;
    const at = (m: number): number => this.nearest(pool, m);
    const shift = this.q(11) < 0.5 ? 2 : -2;
    const out = prev.notes.map((n, k) => {
      let m = n.n;
      if (op === 0) m = pool[clamp(at(2 * first - n.n), 0, pool.length - 1)] ?? n.n;
      else if (op === 1) m = prev.notes[prev.notes.length - 1 - k]?.n ?? n.n;
      else m = pool[clamp(at(n.n) + shift, 0, pool.length - 1)] ?? n.n;
      return { ...n, n: m };
    });
    if (op === 1) {
      // the retrograde keeps the rhythm of the original
      out.forEach((n, k) => {
        const src = prev.notes[k];
        if (src) {
          n.i = src.i;
          n.len = src.len;
        }
      });
    }
    const last = out[out.length - 1];
    if (last) last.n = this.snapChord(last.n, next);
    this.curRun = "answer";
    this.phraseInfo = `answer to the last run (${["inversion", "retrograde", shift > 0 ? "a step up" : "a step down"][op]})`;
    return out;
  }

  /**
   * The lead phrase of a bar, or [] to play the plain theme. Everything is read from the layers: the contour from the theme
   * (the sand-bed scan line), the pitch centre from the tanks' energy centroids, rests and mutations from the wave field.
   *   bebop / swing : an eighth-note line that lands on chord tones on the beat and, before a chord change, encloses a tone of
   *                   the next chord (note above, note a half step below, then the target)
   *   fusion        : a long note, then a 16th-note burst of the scale, or a riff
   *   funk          : a riff on a syncopated rhythm, repeated for two to four bars with small mutations and a fill
   * The more fluent and the wider the vocabulary of the brain (Personality), the more of it is played.
   */
  private makePhrase(bar: number, f: Features, th: Theme | undefined): Note16[] {
    const st = STYLES[this.style];
    const fl = this.fluent;
    const odds = clamp(Math.max(st.lick, 0.7) * (0.3 + 1.4 * this.opts.riffs) * (0.6 + 0.6 * this.brain.chops), 0, 0.97);
    this.phraseInfo = "";
    if (st.lead === "theme" || f.d < 0.08 || this.q(2) >= odds) return [];
    const cur = this.cur;
    const next = progressionOf(this.style, this.prog, this.tension)[(this.chordIndex + 1) % 4] ?? cur;
    const deg = th?.deg ?? [];
    const vr = this.feel.variation;
    const centre = 62 + f.lx * 16 - (f.ly - 0.5) * 6 - (st.lead === "bebop" ? 2 : 0);
    const odd = bar % 2 === 1;
    const out: Note16[] = [];

    this.curRun = null;
    if (st.lead !== "baroque") {
      const runOdds = clamp((0.15 + 0.55 * this.opts.riffs) * (0.5 + 0.7 * this.brain.chops) * (0.7 + 0.6 * vr) * (st.lead === "funk" ? 0.8 : 1), 0, 0.85);
      if (this.lastRun && this.lastRun.left > 0 && this.q(15) < 0.55) {
        const dev = this.developRun(this.lastRun, next);
        this.lastRun.left = 0;
        if (dev.length > 0) return dev;
      }
      if (this.q(14) < runOdds) {
        const run = this.makeRun(f, th, cur, next, centre, st.lead === "swing" || st.lead === "bebop", odd);
        if (run.length > 0) return run;
      }
    }
    if (st.lead === "swing" || st.lead === "bebop") {
      const bop = st.lead === "bebop";
      const pool = this.poolOf(cur.scale);
      let idx = this.nearest(pool, centre + (deg[0] ?? 0));
      let dir = (deg[4] ?? 0) >= (deg[0] ?? 0) ? 1 : -1;
      const first = !bop && this.q(3) < 0.35 ? 1 : 0; // swing lines often enter on the "and"
      const dens = bop ? 0.95 : clamp(0.5 + 0.3 * this.brain.chops + (this.opts.riffs - 0.5) * 0.3, 0.3, 0.9);
      let prev = 0;
      const slots: { j: number; n: number; v: number }[] = [];
      for (let j = first; j < 8; j++) {
        const closing = odd && j >= 6;
        if (j > first && !closing && this.q(4) > dens) continue; // a rest: the soloist breathes
        if (j > first) {
          const d = (deg[j] ?? 0) - (deg[j - 1] ?? 0);
          if (d !== 0 && this.q(5) < 0.5) dir = d > 0 ? 1 : -1;
          idx += dir * (this.q(6) < 0.18 * (0.5 + fl) ? 2 : 1);
          if (idx <= 1 || idx >= pool.length - 2) dir = -dir;
          idx = clamp(idx, 0, pool.length - 1);
        }
        let n = pool[idx] ?? 69;
        let v = j % 2 === 0 ? 6 : -4;
        if (j % 2 === 0 && this.q(7) < (j === 0 ? 0.9 : 0.45) * (0.4 + 0.6 * fl)) {
          n = this.snapChord(n, cur);
          v += 3;
        }
        if (prev && Math.abs(n - prev) > 9) n += n > prev ? -12 : 12;
        if (closing && this.q(8) < 0.3 + 0.6 * fl) {
          // enclosure of the next chord: a tone above (diatonic), then a half step below the target
          const tgt = this.snapChord(prev || n, next);
          n = j === 6 ? tgt + 2 : tgt - 1;
          v += 4;
        }
        prev = n;
        slots.push({ j, n, v });
      }
      slots.forEach((s, k) => {
        const nextJ = slots[k + 1]?.j ?? 8;
        out.push({ i: s.j * 2, n: s.n, v: s.v, len: Math.min(4, (nextJ - s.j) * 2) });
      });
      this.phraseInfo = `${bop ? "bebop run" : "swing line"} ${out.length} notes${odd ? " + enclosure" : ""}`;
      return out;
    }

    if (st.lead === "baroque") {
      // A motif of four notes (its contour read from the theme) is repeated as a sequence that steps down (up in odd bars)
      // along the scale, the way Bach spins a figure through a bar. A practised brain decorates it with mordents, and odd
      // bars end on a trill.
      const pool = this.poolOf(cur.scale);
      const base = this.nearest(pool, centre + 2 + (deg[0] ?? 0));
      const shape = [0, 1, 2, 3].map((j) => clamp(Math.round(((deg[j * 2] ?? 0) - (deg[0] ?? 0)) / 2), -2, 2));
      if (shape.every((x) => x === shape[0])) shape.splice(0, 4, 0, 1, 0, -1);
      const stepDir = odd ? 1 : -1;
      const trill = odd && this.q(9) < 0.25 + 0.6 * fl;
      for (let rep = 0; rep < (trill ? 3 : 4); rep++) {
        shape.forEach((sh, j) => {
          const at = clamp(base + stepDir * rep + sh, 0, pool.length - 1);
          const n = pool[at] ?? 69;
          const note: Note16 = { i: rep * 4 + j, n, v: j === 0 ? 5 : -2, len: 1 };
          if (j === 0 && this.q(10 + rep) < (0.1 + 0.4 * fl) * (0.4 + vr)) {
            const up = pool[clamp(at + 1, 0, pool.length - 1)] ?? n + 2;
            note.len = 2;
            note.orn = [{ n, at: 0, len: 0.33 }, { n: up, at: 0.33, len: 0.33 }, { n, at: 0.67, len: 1.33 }];
          }
          out.push(note);
        });
      }
      if (trill) {
        const tgt = this.snapChord(pool[clamp(base - 2, 0, pool.length - 1)] ?? 69, next);
        const up = pool[clamp(this.nearest(pool, tgt) + 1, 0, pool.length - 1)] ?? tgt + 2;
        const orn: { n: number; at: number; len: number }[] = [];
        for (let a = 0; a < 8; a++) orn.push({ n: a % 2 === 0 ? tgt : up, at: a * 0.5, len: 0.5 });
        out.push({ i: 12, n: tgt, v: 6, len: 4, orn });
      }
      this.phraseInfo = `baroque sequence ${stepDir < 0 ? "down" : "up"} ${shape.join(" ")}${trill ? " + trill" : ""}${out.some((x) => x.orn && x.len === 2) ? " + mordent" : ""} · canon follows a bar later`;
      return out;
    }

    const pentPcs = (c: Chord): number[] => {
      const maj = c.bass.includes(4) && c.bass.includes(11);
      return (maj ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10]).map((i) => (c.root + i) % 12);
    };
    const burst = st.lead === "fusion" && this.q(9) < 0.5 + 0.2 * vr;
    if (burst) {
      const scale = this.poolOf(cur.scale);
      out.push({ i: 0, n: this.snapChord(scale[this.nearest(scale, centre)] ?? 66, cur), v: 8, len: 5 });
      const start = 6 + 2 * Math.floor(this.q(10) * 3);
      let idx = this.nearest(scale, centre + (deg[2] ?? 0));
      let dir = (deg[5] ?? 0) >= (deg[2] ?? 0) ? 1 : -1;
      let run = 0;
      for (let i = start; i < 16; i++) {
        if (i < 14 && this.q(11) > 0.92) continue; // a hole in the run
        idx += dir * (this.q(12) < 0.15 * (0.5 + fl) ? 2 : 1);
        if (++run % (4 + Math.floor(this.q(13) * 3)) === 0 || idx <= 1 || idx >= scale.length - 2) dir = -dir;
        idx = clamp(idx, 0, scale.length - 1);
        let n = scale[idx] ?? 69;
        if (i === 15 && odd) n = this.snapChord(n, next) - (this.q(14) < 0.5 ? 1 : 0);
        out.push({ i, n, v: 1 + (i - start), len: 1 });
      }
      this.phraseInfo = `fusion burst, ${out.length - 1} sixteenths`;
      return out;
    }

    // Riff: a rhythm, a contour and a repeat count; the riff is kept for two to four bars and transposed onto each chord.
    if (!this.riff || this.riff.left <= 0) {
      const rhythm = this.brain.pick("riff:", this.brain.rhythms.length, this.q(8));
      const pat = this.brain.rhythms[rhythm] ?? "x..x.x..x.x..x..";
      const hits = pat.split("").filter((c) => c === "x").length;
      // the contour is the theme's, bent by the layers' noise so two riffs on the same rhythm still differ
      const steps = Array.from({ length: hits }, (_, j) => Math.round((deg[j % 8] ?? 0) / 2 + (this.q(13) - 0.5) * 3 * vr));
      this.riff = { rhythm, pat, steps, left: 2 + Math.floor(this.q(9) * 3) };
    }
    const riff = this.riff;
    riff.left--;
    // Each repeat develops the riff: one step changed, inverted, played backwards or lifted.
    if (this.q(10) < 0.25 + 0.6 * vr) {
      const op = Math.floor(this.q(11) * 4);
      if (op === 0) {
        const j = Math.floor(this.q(12) * riff.steps.length) % Math.max(1, riff.steps.length);
        riff.steps[j] = (riff.steps[j] ?? 0) + (this.q(14) < 0.5 ? -1 : 1);
      } else if (op === 1) riff.steps = riff.steps.map((x) => -x);
      else if (op === 2) riff.steps.reverse();
      else riff.steps = riff.steps.map((x, j) => x + (j === riff.steps.length - 1 ? 2 : 1));
    }
    const pent = this.poolOf(pentPcs(cur));
    const anchor = this.nearest(pent, centre - 3);
    const rhythm = riff.pat;
    let j = 0;
    for (let i = 0; i < 16; i++) {
      if (rhythm[i] !== "x") continue;
      let n = pent[clamp(anchor + (riff.steps[j++] ?? 0), 0, pent.length - 1)] ?? 69;
      if (i === 0) n = this.snapChord(n, cur);
      const short = rhythm[i + 1] === "x" || rhythm[i + 2] === "x";
      out.push({ i, n, v: (i % 4 === 0 ? 6 : 0) + (i === 0 ? 4 : 0), len: short ? 1 : 2 });
    }
    if (riff.left === 0 && fl > 0.3) {
      // the last repeat ends in a little fill
      for (let k = 0; k < 3; k++) out.push({ i: 13 + k, n: pent[clamp(anchor + 3 - k, 0, pent.length - 1)] ?? 69, v: 2 + k, len: 1 });
    }
    this.phraseInfo = `riff ${riff.rhythm + 1}/${this.brain.rhythms.length} (generation ${this.brain.generation}), repeat ${riff.left + 1} more`;
    return out;
  }

  private send(ch: number, note: number, vel: number, t: number, dur: number): void {
    const out = this.midi;
    if (!out || !this.midiOn) return;
    const ms = performance.now() + (t - this.ctx.currentTime) * 1000;
    out.send([0x90 | ch, note, vel], ms);
    out.send([0x80 | ch, note, 0], ms + dur * 1000);
  }

  /** Advances every running instrument handover by one grid slot; the MIDI program change goes out half way through. */
  private tickHandover(): void {
    let active = false;
    for (const key of ["bass", "comp", "lead", "ride"] as const) {
      const h = this.ho[key];
      if (h.x >= 1) continue;
      const before = h.x;
      h.x = Math.min(1, h.x + 1 / HANDOVER_SLOTS);
      if (before < 0.5 && h.x >= 0.5 && key !== "ride") {
        const table = key === "bass" ? BASS_PATCHES : key === "comp" ? KEYS_PATCHES : LEAD_PATCHES;
        this.program(CH[key], table[this.patch[key]]?.gm ?? 0);
      }
      active = true;
    }
    if (active && this.step % 4 === 0) this.describePatches();
  }

  /** Picks a new way to voice the current chord (never the same twice in a row) and voice-leads it from the last one. */
  private revoice(tag: string | null): void {
    let v = Math.min(3, Math.floor((0.6 * this.heat + 0.4 * this.q(5)) * 4));
    if (v === this.lastVariant) v = (v + 1) % 4;
    this.lastVariant = v;
    this.vox = voiceLead(this.cur, this.vox, v);
    this.strumVox = voiceLead(this.cur, [], GUITAR_VOICING);
    this.apprVox = this.approach ? voiceLead(this.approach, this.vox, 1) : [];
    this.apprStrum = this.approach ? voiceLead(this.approach, [], GUITAR_VOICING) : [];
    if (tag !== null) this.harmonyInfo = tag;
    this.harmonyNow = `${this.cur.name} · ${VOICING_NAMES[v]} voicing · heat ${Math.round(this.heat * 100)}%${this.harmonyInfo ? ` · ${this.harmonyInfo}` : ""}`;
  }

  private play(t: number, stepLen: number, p: Params, f: Features, silent: boolean): void {
    this.tickHandover();
    const s = this.step;
    const inChord = s % 16;
    const beat = inChord >> 1;
    const off = (s & 1) === 1;
    const q = beat % 4;
    if (s % 8 === 0) this.chooseStyle(s >> 3, f);
    if (inChord === 0 || s === 0) {
      this.chordIndex = Math.floor(s / 16) % 4;
      const chords = progressionOf(this.style, this.prog, f.tension);
      const base = chords[this.chordIndex] ?? this.cur;
      // The harmonic plan: layer 6 (and the slow arc of the form) decides how adventurous the chords are.
      this.heat = harmonicHeat(s >> 3, f.rms[5] ?? 0, f.tension, f.brain);
      const plan = planChord(base, chords[(this.chordIndex + 1) % 4] ?? base, this.heat, [this.q(5), this.q(6), this.q(7)]);
      this.cur = plan.chord;
      this.approach = plan.approach;
      this.chordName = this.cur.name;
      this.revoice(plan.tag);
      this.snapTones = [...new Set([...this.cur.bass, 2].map((i) => (((this.cur.root + i - 2) % 12) + 12) % 12))];
    }
    if (inChord === 8 && !silent) this.revoice(null);
    const accents = this.accents;
    this.accents = [];
    const typed = this.typed.shift();
    const sung = this.sung.shift();
    if (silent) {
      this.sung = [];
      this.typed = [];
      this.echoes = [];
      return;
    }

    const cur = this.cur;
    if (sung !== undefined) {
      this.echoes.push({ step: this.step + 2, kind: "layer", code: 0, midi: sung }, { step: this.step + 5, kind: "stab", code: 0 });
      this.echoInfo = `heard you sing ${sung}`;
    }
    // Typing into layer 1: the typed character is played at once as a note of the current scale (the same letter is always
    // the same scale degree), then the brain answers: the loudest layer sings it back three slots later, a keys stab follows.
    if (typed) {
      const note = this.scaleNote(cur, typed.code);
      this.leadNote(t, note, 64 + (typed.code % 9) * 5, stepLen * 1.5);
      this.echoes.push({ step: this.step + 3, kind: "layer", code: typed.code }, { step: this.step + 6, kind: "stab", code: typed.code });
      this.echoInfo = `typed "${String.fromCharCode(typed.code)}" -> ${note}`;
    }
    this.echoes = this.echoes.filter((e) => {
      if (e.step > this.step) return true;
      if (e.kind === "layer") {
        let l = 1;
        let best = -1;
        for (let i = 1; i < NUM_LAYERS; i++) {
          const w = f.rms[i] ?? 0;
          if (w > best) {
            best = w;
            l = i;
          }
        }
        const n = e.midi !== undefined ? this.snapChord(e.midi + (this.q(2) < 0.5 ? 2 : -3), cur) : this.layerNote(l, cur, f);
        if (this.lv.choir >= 0.05) this.choirNote(l, t, n, 74, stepLen * 4);
        else this.leadNote(t, n - 12, 56, stepLen * 2.5);
        this.echoInfo = `brain answers ${e.midi !== undefined ? "your voice " : ""}with L${l + 1} (note ${n})`;
      } else {
        this.comp(t, (this.vox.length > 0 ? this.vox : cur.voicing).slice(-3), 62, stepLen * 2, 3);
      }
      return false;
    });
    const nextChord = progressionOf(this.style, this.prog, f.tension)[(this.chordIndex + 1) % 4] ?? cur;
    const st = STYLES[this.style];
    const groove = this.opts.groove;
    const fl = this.fluent;
    const bar = s >> 3;
    const beatDur = 60 / this.bpm;
    const hum = this.feel.human * 2; // 1 = as designed, 0 = machine-exact
    const vel = (base: number, span: number): number => Math.round(clamp(base + span * f.d + ((this.q(0) - 0.5) * 10 + Math.sin(s * 0.19) * 5) * hum, 1, 127));
    const dens = p.bandDensity * 2;
    // A young brain is looser in time than a practised one.
    const loose = (0.3 + p.dust * 3) * 0.012 * (1.7 - f.health) * hum * (1.6 - 0.9 * fl);
    const jit = (l: number): number => Math.max(this.ctx.currentTime, t + (this.q(l) - 0.5) * loose);
    const tight = (l: number): number => Math.max(this.ctx.currentTime, t + (this.q(l) - 0.5) * loose * 0.4);
    const laidBack = 0.022 * this.feel.human; // the soloist sits a little behind the beat
    const k = s % 8; // slot of the bar
    // Each eighth-note slot holds two sixteenths: on the slot itself and half a slot later.
    const subs: readonly (readonly [number, number])[] = [
      [2 * k, t],
      [2 * k + 1, t + stepLen * 0.5],
    ];
    const at = (tt: number, l: number, span = 1): number => Math.max(this.ctx.currentTime, tt + (this.q(l) - 0.5) * loose * span);
    if (k === 0 && bar % 4 === 3) this.fillRolled = this.q(9) < 0.25 + 0.5 * groove * fl + 0.2 * f.d;
    const filling = this.fillRolled && f.d > 0.05 && st.drums !== "bossa" && st.drums !== "none" && bar % 4 === 3 && k >= 6;

    // Walking bass: one note per beat, always from the bottom layer's activity. A practised brain approaches the next
    // downbeat chromatically and drops in skip notes between the beats.
    if (st.bass === "walk" && !off && f.d > 0.02) {
      let n: number;
      if (beat === 7) {
        const target = nextChord.root;
        n = Math.abs(target + 1 - this.lastBass) < Math.abs(target - 1 - this.lastBass) ? target + 1 : target - 1;
        if (f.cy > 0.5) n = target + 1;
        else if (f.cy < 0.35) n = target - 1;
      } else if (q === 0) n = cur.root;
      else if (q === 3 && fl > 0.45 && this.q(0) < fl) n = cur.root + (this.q(1) < 0.5 ? 1 : -1);
      else n = cur.root + (cur.bass[(Math.floor(f.cx * 7) + beat) % cur.bass.length] ?? 0);
      while (n > 55) n -= 12;
      while (n < 28) n += 12;
      // A note that was pushed ahead onto the "and" before is tied: it replaces this one instead of sounding again.
      const pushed = this.bassPush;
      this.bassPush = null;
      if (pushed !== null) n = pushed;
      this.lastBass = n;
      if (pushed === null) this.bassNote(tight(0), n, vel(62, 40), beatDur * 0.92);
    }
    if (st.bass === "walk" && off && f.d > 0.02) {
      // Syncopation: the next beat's note is played early, on the "and", and the beat itself stays empty.
      const syn = (0.1 + 0.4 * groove * fl) * (0.6 + 0.8 * this.feel.variation);
      if (this.q(2) < syn * 0.6) {
        let n = beat === 7 ? nextChord.root : cur.root + (cur.bass[(Math.floor(f.cx * 7) + beat + 1) % cur.bass.length] ?? 0);
        while (n > 55) n -= 12;
        while (n < 28) n += 12;
        this.bassPush = n;
        this.bassNote(tight(0), n, vel(68, 40), beatDur * 1.1);
      } else if ((q === 1 || q === 3) && this.q(2) < groove * fl * 0.35) this.bassNote(tight(0), this.lastBass, vel(38, 20), beatDur * 0.25);
    }

    // Funk and fusion bass: a 16th-note pattern on the one, with octave pops, fifths, flat sevens and ghost notes.
    if (st.bass === "funk" && f.d > 0.02) {
      const pat = FUNK_BASS[this.bassPat] ?? "";
      for (const [i, tt] of subs) {
        const ch = pat[i];
        if (!ch || ch === ".") continue;
        if (ch === "g" && this.q(0) > groove * (0.4 + 0.6 * fl) + 0.1) continue;
        if (i !== 0 && ch !== "1" && ch !== "g" && this.q(1) > 0.55 + 0.45 * groove) continue;
        let n = cur.root + (ch === "o" ? 12 : ch === "5" ? cur.bass[2] ?? 7 : ch === "7" ? cur.bass[3] ?? 10 : 0);
        const approach = inChord === 15 && i === 2 * k + 1 && this.q(2) < fl * 0.7;
        if (approach) n = nextChord.root - 1;
        while (n > (ch === "o" ? 60 : 55)) n -= 12;
        while (n < 28) n += 12;
        this.lastBass = n;
        const ghost = ch === "g" && !approach;
        this.bassNote(at(tt, 3, 0.4), n, ghost ? 30 : i === 0 ? vel(78, 30) : vel(60, 30), ghost ? 0.05 : beatDur * (ch === "o" ? 0.22 : 0.3));
      }
    }
    // Bossa bass: root on one, fifth on the "and" of two, root on three, fifth on the "and" of four.
    // Baroque running bass: a steady line of eighths through the chord tones, the root an octave down on the downbeat.
    if (st.bass === "arp" && f.d > 0.02) {
      const idx = [0, 2, 1, 2, 0, 3, 1, 2][s % 8] ?? 0;
      let n = cur.root + (cur.bass[idx] ?? 0);
      while (n > 55) n -= 12;
      while (n < 30) n += 12;
      if (inChord === 0) n = Math.max(28, cur.root - 12);
      this.lastBass = n;
      this.bassNote(tight(0), n, vel(inChord % 8 === 0 ? 62 : 48, 22), beatDur * 0.48);
    }
    if (st.bass === "bossa" && f.d > 0.02 && (k === 0 || k === 3 || k === 4 || k === 7)) {
      let n = cur.root + (k === 3 || k === 7 ? cur.bass[2] ?? 7 : 0);
      while (n > 52) n -= 12;
      while (n < 28) n += 12;
      this.lastBass = n;
      this.bassNote(tight(0), n, vel(58, 30), beatDur * (k === 0 || k === 4 ? 1.3 : 0.45));
    }

    // Ride cymbal (swing, bebop): quarter notes plus the swung skip beat, loosened by Dust; foot hi-hat on 2 and 4.
    if (f.d > 0.02 && st.drums === "swing") {
      const skip = off && (q === 1 || q === 3);
      if ((!off || skip) && this.q(1) > p.dust * 0.5) {
        const v = Math.round(clamp((skip ? 38 : 48) + 26 * f.d + (q === 1 || q === 3 ? 6 : 0) + (this.q(1) - 0.5) * 14 * (0.3 + p.dust * 3), 1, 127));
        this.rideHit(jit(1), v, 0.4);
      }
      if (!off && (q === 1 || q === 3)) this.hatFoot(t, Math.round(30 + 25 * f.d));
      // Feathered kick and ghost-snare "bombs": a practised drummer drops them between the ride beats.
      if (!off && q === 0 && this.q(4) < 0.3 + 0.3 * fl) this.kick(jit(4), Math.round(18 + 14 * f.d));
      if (off && q !== 0 && this.q(5) < groove * fl * 0.3) this.snare(jit(5), Math.round(16 + 12 * f.d));
    }

    // Funk, fusion and bossa grooves with kick and snare, played on the sixteenth grid.
    if (f.d > 0.02 && st.drums !== "swing" && st.drums !== "none") {
      const kp = KICKS[this.kickPat] ?? "";
      for (const [i, tt] of subs) {
        const ghostOk = GHOST_SLOTS.includes(i) && this.q(6) < groove * (0.25 + 0.5 * fl);
        if (st.drums === "bossa") {
          if (!(i & 1)) this.rideHit(at(tt, 1, 0.5), Math.round(26 + 18 * f.d), 0.1);
          if (BOSSA_KICK[i] === "k") this.kick(tight(2), Math.round(46 + 22 * f.d));
          if (BOSSA_CLAVE[bar % 2]?.[i] === "x") this.rim(at(tt, 3, 0.4), Math.round(42 + 20 * f.d));
          continue;
        }
        const funk = st.drums === "funk";
        if (funk || !(i & 1) || this.q(1) < groove * 0.4) this.rideHit(at(tt, 1, 0.5), Math.round((i % 4 === 0 ? 40 : 24) + 22 * f.d), funk ? 0.1 : 0.35);
        if (kp[i] === "k" && (i === 0 || this.q(2) < 0.6 + 0.4 * groove)) this.kick(at(tt, 2, 0.3), Math.round(60 + 30 * f.d));
        if ((i === 4 || i === 12) && !filling) this.snare(at(tt, 3, 0.3), Math.round(62 + 34 * f.d));
        else if (ghostOk && !filling) this.snare(at(tt, 4, 0.5), Math.round(18 + 10 * f.d));
        if (funk && i === 14 && this.q(5) < 0.5 * groove) this.rideHit(tt, Math.round(52 + 20 * f.d), 0.9);
      }
    }

    // A drum fill at the end of every fourth bar (not in bossa): the last two beats run in sixteenths, a crescendo around the
    // snare and the toms, and every fill is different. The busier and more fluent the brain, the more often it fills.
    if (filling) {
      const toms = [50, 47, 45, 43];
      for (const [i, tt] of subs) {
        const n = i - 12; // 0..3 over the last two beats
        const v = Math.round(clamp(38 + n * 14 + 28 * f.d, 1, 127));
        const pick = Math.floor(this.q(10 + n) * 4);
        if (pick === 0) this.snare(at(tt, 3, 0.3), v, 0.9 + 0.1 * n);
        else if (pick === 3 && n >= 2) this.kick(at(tt, 2, 0.3), v);
        else this.tom(at(tt, 3, 0.3), v, toms[(n + pick) % 4] ?? 45);
      }
    }

    // Comping. The chord is the voice-led one of the harmonic plan (cv); the last two beats of a chord may belong to an
    // approach chord. Rhythms: a swing pattern (charleston and others), chicken-scratch 16ths, the bossa clave, or, when the
    // keys are the guitar, a strum pattern with down-strums, up-strums and muted chops. Layer 5 picks the pattern.
    const lk = this.sim?.lock;
    const sync = lk ? (lk[k] ?? 0) - lk.reduce((x, y) => x + y, 0) / lk.length : 0;
    const useAppr = this.approach !== null && inChord >= 12 && this.apprVox.length > 0;
    const cv: readonly number[] = useAppr ? this.apprVox : this.vox.length > 0 ? this.vox : cur.voicing;
    const shape = useAppr ? this.apprStrum : this.strumVox;
    const cvel = (base: number, span: number): number => vel(base + (this.heat - 0.4) * 14, span);
    const guitar = this.patch.comp === GUITAR_PATCH && shape.length > 0;
    const bpat = STRUMS[(this.strumPat + (bar % 4 === 3 ? 3 : 0)) % STRUMS.length] ?? "";
    if (guitar && f.d > 0.05) {
      for (const [i, tt] of subs) {
        const ch = bpat[i];
        const alive = this.q(3) < 0.55 + 0.45 * Math.min(1, dens);
        if (ch === "D") this.comp(at(tt, 3, 0.4), shape, cvel(50, 30), beatDur * 0.5, shape.length, 0.011);
        else if (ch === "x") this.comp(at(tt, 3, 0.4), shape, cvel(60, 30), beatDur * 0.22, shape.length, 0.007);
        else if (ch === "u" && alive) this.comp(at(tt, 3, 0.4), shape.slice(-4).reverse(), cvel(32, 18), beatDur * 0.2, 4, 0.006);
        else if (ch === "m" && alive && this.q(3) < 0.4 + 0.6 * groove) this.comp(at(tt, 3, 0.4), shape.slice(0, 3), cvel(22, 12), 0.04, 3, 0.004);
      }
    } else if (st.comp === "charleston") {
      const anticipate = k === 7 && bar % 2 === 1 && f.d > 0.05 && this.q(7) < groove * fl * 0.6; // the "and of four" pushes into the next chord
      const hit = (SWING_COMP[this.swcPat] ?? "")[s % 16];
      const patHit = (hit === "x" || hit === "X") && this.q(3) < 0.6 + 0.4 * Math.min(1, dens);
      const compWanted = f.d > 0.05 && (patHit || (off && sync > 0 && this.q(3) < (0.15 + 0.5 * f.crest) * dens));
      if (compWanted || anticipate) {
        const notes = anticipate ? voiceLead(nextChord, cv, 1) : cv;
        this.comp(jit(3), notes.slice(-(f.crest < 0.3 ? 3 : 4)), cvel(hit === "X" ? 48 : 40, 34), beatDur * (hit === "X" ? 0.75 : 0.4), 4);
      }
    } else if (st.comp === "chicken" && f.d > 0.05) {
      const pat = CHICKEN[this.compPat] ?? "";
      for (const [i, tt] of subs) {
        const ch = pat[i];
        if (ch === "x") this.comp(at(tt, 3, 0.4), cv, cvel(46, 30), 0.14, 4);
        else if (ch === "m" && this.q(3) < 0.4 + 0.6 * groove) this.comp(at(tt, 3, 0.4), cv.slice(-2), cvel(24, 14), 0.04, 2);
      }
    } else if (st.comp === "bossa" && f.d > 0.05) {
      for (const [i, tt] of subs) if (BOSSA_CLAVE[bar % 2]?.[i] === "x") this.comp(at(tt, 3, 0.4), cv, cvel(38, 26), beatDur * 0.35, 4);
    }
    // The approach chord announces itself with a push on its first beat.
    if (useAppr && inChord === 12 && f.d > 0.05 && st.comp !== "none") this.comp(jit(3), guitar ? shape : cv, cvel(50, 30), beatDur * 0.8, guitar ? shape.length : 4, guitar ? 0.011 : 0.007);
    // Full ringing chords: like a pianist, land the whole chord (left-hand root plus the right-hand voicing, gently rolled
    // upwards) on every change, and again halfway through the chord. The stabs above only ever use two or three notes.
    const struck = guitar && (bpat[0] === "D" || bpat[0] === "x");
    if (!struck && f.d > 0.02 && (inChord === 0 || (inChord === 8 && this.q(6) < 0.55 + 0.4 * groove))) {
      const full = [cur.root + 12, ...cv];
      this.comp(jit(3), full, cvel(inChord === 0 ? 58 : 46, 30), beatDur * (inChord === 0 ? 3.2 : 2.2), full.length, 0.013);
    }
    for (const a of accents) {
      const top = (this.vox.length > 0 ? this.vox : cur.voicing).slice(-3).map((n) => n + (a.layer >= 7 ? 12 : 0));
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
    if (k === 0) this.prepareBar(bar, f, false);
    const th = this.answer && k >= 5 ? this.answer : this.themeFor(bar);
    const vr = this.feel.variation * this.feel.variation; // variation 0.5 adds little, 1 reinvents the line
    // Canon: the keys answer last bar's phrase an octave lower, fitted onto the current chord.
    if (st.lead === "baroque" && f.d > 0.05) {
      for (const n of this.prevPhrase) {
        if (n.i !== 2 * k && n.i !== 2 * k + 1) continue;
        const pool = this.poolOf(cur.scale, 40, 80);
        const m = pool[this.nearest(pool, n.n - 12)] ?? n.n - 12;
        const tt = n.i === 2 * k ? t : t + stepLen * 0.5;
        this.comp(Math.max(this.ctx.currentTime, tt + 0.01), [m], Math.round(clamp(vel(40, 26) + n.v * 0.5, 1, 127)), Math.max(0.08, n.len * stepLen * 0.45), 1);
      }
    }
    if (this.phrase.length > 0) {
      // A written phrase (licks, runs, riffs) replaces the plain theme for this bar.
      for (const n of this.phrase) {
        if (n.i !== 2 * k && n.i !== 2 * k + 1) continue;
        if (f.d <= 0.05) continue;
        const tt = n.i === 2 * k ? t : t + stepLen * 0.5;
        const swung = Math.max(this.ctx.currentTime, tt + laidBack + (this.q(2) - 0.5) * loose * 0.6);
        this.leadMidi = n.n;
        const lv = Math.round(clamp(vel(52, 44) + n.v, 1, 127));
        if (n.orn) for (const o of n.orn) this.leadNote(swung + o.at * stepLen * 0.5, o.n, lv, Math.max(0.04, o.len * stepLen * 0.5 * 0.9));
        else this.leadNote(swung, n.n, lv, Math.max(0.06, n.len * stepLen * 0.5 * 0.9));
      }
      return;
    }    const extra = this.q(4) < 0.3 * vr; // a slot that is not in the theme's rhythm joins in
    if (th && f.d > 0.08 && (th.hit[k] === true || extra) && this.q(2) < clamp(dens * (0.4 + 0.8 * lerp1(f.d, f.rms[k] ?? 0, f.brain)), 0, 1)) {
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
      idx = clamp(idx + (th.deg[k] ?? 0) + Math.round((this.q(5) - 0.5) * 5 * vr), 0, pool.length - 1);
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
      if (this.q(6) < 0.4 * vr) {
        const gi = clamp(idx + (this.q(7) < 0.5 ? -1 : 1), 0, pool.length - 1);
        this.leadNote(Math.max(this.ctx.currentTime, t - stepLen * 0.18), pool[gi] ?? note, vel(38, 26), stepLen * 0.22); // grace note
      }
      this.leadNote(Math.max(this.ctx.currentTime, t + laidBack + (this.q(2) - 0.5) * loose * 0.6), note, vel(52, 44), stepLen * 0.9);
    }
  }

  /** A typed character as a note of the current scale: the same character is always the same scale degree. */
  private scaleNote(cur: Chord, code: number): number {
    const pool: number[] = [];
    for (let m = 57; m <= 86; m++) if (cur.scale.includes(m % 12)) pool.push(m);
    return pool[(code * 7) % pool.length] ?? 69;
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
    // The timbre follows the layer's signature slowly: the patch only changes well inside another band, and the modulator
    // ratio glides towards it note by note instead of jumping.
    const s = this.sig(l) * CHOIR_PATCHES.length;
    let pi = Math.floor(s);
    const prevPi = this.choirPatch[l] ?? pi;
    if (this.choirSent[l] !== -1 && pi !== prevPi && (s - pi < 0.25 || s - pi > 0.75)) pi = prevPi;
    const cp = CHOIR_PATCHES[pi] ?? (CHOIR_PATCHES[0] as (typeof CHOIR_PATCHES)[number]);
    this.choirPatch[l] = pi;
    const cch = CHOIR_CH[l - 1] ?? 3;
    if (this.choirSent[l] !== pi) {
      this.program(cch, cp.gm);
      this.choirSent[l] = pi;
    }
    const ratio = (this.choirRatio[l] ?? cp.ratio) + (cp.ratio - (this.choirRatio[l] ?? cp.ratio)) * 0.2;
    this.choirRatio[l] = ratio;
    this.heard("choir", vel, 0.13);
    this.send(cch, midi, vel, t, dur);
    const ctx = this.ctx;
    const f = mtof(midi);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    const g = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * ratio;
    mg.gain.setValueAtTime(f * (0.5 + 0.7 * clamp((this.sim?.crest[l] ?? 1) / 3, 0, 1)), t);
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
    this.heard("bass", vel, 0.55);
    for (const [kind, w] of this.mix("bass")) if (w > 0.02) this.bassVoice(kind, w, t, midi, vel, dur);
  }

  private bassVoice(kind: number, w: number, t: number, midi: number, vel: number, dur: number): void {
    const ctx = this.ctx;
    const f = mtof(midi);
    const a = ((kind === 3 ? 0.62 : kind === 2 ? 0.4 : 0.55) * vel * w) / 127;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    const [open, close, q, types] =
      kind === 1
        ? ([1500, 600, 0.7, ["sawtooth", "sine"]] as const)
        : kind === 2
          ? ([2600, 280, 7, ["square", "sawtooth"]] as const)
          : kind === 3
            ? ([420, 300, 0.5, ["sine", "sine"]] as const)
            : ([900, 260, 0.7, ["triangle", "sine"]] as const);
    lp.Q.value = q;
    lp.frequency.setValueAtTime(open, t);
    lp.frequency.exponentialRampToValueAtTime(close, t + (kind === 2 ? Math.min(dur, 0.25) : dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + (kind === 3 ? 0.02 : 0.008));
    g.gain.exponentialRampToValueAtTime(Math.max(a * (kind === 2 ? 0.2 : 0.35), 0.0002), t + dur * 0.9);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.06);
    types.forEach((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = i === 1 && kind === 2 ? f * 1.004 : f;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.08);
    });
    lp.connect(g).connect(this.spat.bass.input);
  }

  // Electric-piano style FM voices.
  private comp(t: number, notes: readonly number[], vel: number, dur: number, count: number, strum = 0.007): void {
    vel = Math.round(vel * this.lv.comp);
    if (vel < 2) return;
    notes.slice(0, count).forEach((midi, i) => {
      this.send(CH.comp, midi, vel, t + i * strum, dur);
    });
    this.voices.comp.level = Math.max(this.voices.comp.level, vel / 127);
    this.heard("comp", vel, 0.2);
    for (const [kind, w] of this.mix("comp")) if (w > 0.02) this.compVoice(kind, w, t, notes, vel, dur, count, strum);
  }

  private compVoice(kind: number, w: number, t: number, notes: readonly number[], vel: number, dur: number, count: number, strum: number): void {
    const ctx = this.ctx;
    notes.slice(0, count).forEach((midi, i) => {
      const tt = t + i * strum;
      const f = mtof(midi);
      const x = vel / 127;
      if (kind === GUITAR_PATCH) {
        this.pluck(tt, f, x, w, dur, count);
        return;
      }
      const P = [
        { ratio: 1, i0: 1.2 + x * 1.6, i1: 0.25, itime: 0.5, atk: 0.004, sustain: false, end: 0.9, type: "sine", amp: 1 },
        { ratio: 4, i0: 0.8 + x * 0.6, i1: 0.02, itime: 0.4, atk: 0.003, sustain: false, end: 1.7, type: "sine", amp: 1.1 },
        { ratio: 2, i0: 0.35, i1: 0.35, itime: 0.1, atk: 0.02, sustain: true, end: 0, type: "sine", amp: 0.7 },
        { ratio: 2, i0: 2.2 * (0.6 + x), i1: 0.05, itime: 0.12, atk: 0.002, sustain: false, end: 0.55, type: "triangle", amp: 1.2 },
        { ratio: 1.003, i0: 0.15, i1: 0.15, itime: 0.1, atk: 0.14, sustain: true, end: 0, type: "sawtooth", amp: 0.4 },
      ] as const;
      const pp = P[kind] ?? P[0];
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const mg = ctx.createGain();
      const g = ctx.createGain();
      car.type = pp.type;
      car.frequency.value = f;
      mod.frequency.value = f * pp.ratio;
      mg.gain.setValueAtTime(pp.i0 * f, tt);
      mg.gain.exponentialRampToValueAtTime(Math.max(pp.i1, 0.001) * f, tt + pp.itime);
      const a = (0.3 * x * pp.amp * w) / Math.sqrt(count);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(a, tt + pp.atk);
      let stop: number;
      if (pp.sustain) {
        const hold = Math.max(kind === 4 ? dur * 3 : dur, 0.2);
        g.gain.linearRampToValueAtTime(a * 0.85, tt + hold);
        g.gain.linearRampToValueAtTime(0.0001, tt + hold + (kind === 4 ? 0.5 : 0.08));
        stop = tt + hold + (kind === 4 ? 0.55 : 0.1);
      } else {
        g.gain.exponentialRampToValueAtTime(0.0005, tt + pp.end);
        stop = tt + pp.end + 0.05;
      }
      mod.connect(mg).connect(car.frequency);
      if (kind === 4) {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 1300;
        car.connect(lp).connect(g);
      } else car.connect(g);
      g.connect(this.spat.comp.input);
      car.start(tt);
      mod.start(tt);
      car.stop(stop);
      mod.stop(stop);
    });
  }

  /** A plucked steel string: a bright saw that darkens quickly (filter envelope), a soft octave string and a pick click. */
  private pluck(t: number, f: number, x: number, w: number, dur: number, count: number): void {
    const ctx = this.ctx;
    const body = ctx.createOscillator();
    const shimmer = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const sg = ctx.createGain();
    body.type = "sawtooth";
    body.frequency.value = f;
    shimmer.type = "triangle";
    shimmer.frequency.value = f * 2.003;
    sg.gain.value = 0.22;
    lp.type = "lowpass";
    lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(Math.min(9000, f * (5 + 9 * x)), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.6, 350), t + 0.3);
    const a = (0.2 * (0.4 + x) * w) / Math.sqrt(count);
    const ring = Math.min(2.4, 0.55 + dur * 1.4 + 90 / f);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0005, t + ring);
    body.connect(lp);
    shimmer.connect(sg).connect(lp);
    lp.connect(g).connect(this.spat.comp.input);
    body.start(t);
    shimmer.start(t);
    body.stop(t + ring + 0.05);
    shimmer.stop(t + ring + 0.05);
    this.noiseBurst(t, this.spat.comp.input, 2600, a * 0.45, 0.012, 3400);
  }

  private leadNote(t: number, midi: number, vel: number, dur: number): void {
    vel = Math.round(vel * this.lv.lead);
    if (vel < 2) return;
    this.send(CH.lead, midi, vel, t, dur);
    this.voices.lead.level = Math.max(this.voices.lead.level, vel / 127);
    this.heard("lead", vel, 0.2);
    for (const [kind, w] of this.mix("lead")) if (w > 0.02) this.leadVoice(kind, w, t, midi, vel, dur);
  }

  private leadVoice(kind: number, w: number, t: number, midi: number, vel: number, dur: number): void {
    const ctx = this.ctx;
    const f = mtof(midi);
    const o = ctx.createOscillator();
    o.type = kind === 1 ? "sine" : kind === 2 || kind === 3 ? "square" : "sawtooth";
    o.frequency.value = f;
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = kind === 1 ? 5 : 5.5;
    lg.gain.value = kind === 1 ? 14 : kind === 2 ? 6 : 10;
    lfo.connect(lg).connect(o.detune);
    const lp = ctx.createBiquadFilter();
    if (kind === 2) {
      lp.type = "bandpass";
      lp.Q.value = 2.2;
      lp.frequency.setValueAtTime(800 + vel * 8, t);
      lp.frequency.linearRampToValueAtTime(1200 + vel * 6, t + 0.08);
    } else {
      lp.type = "lowpass";
      lp.Q.value = kind === 3 ? 1 : kind === 1 ? 0.5 : 2;
      const base = kind === 1 ? 2600 : kind === 3 ? 1500 : 900 + vel * 14;
      lp.frequency.setValueAtTime(base, t);
      lp.frequency.exponentialRampToValueAtTime(kind === 0 ? 500 + vel * 4 : base * 0.8, t + dur);
    }
    const g = ctx.createGain();
    const a = ((kind === 2 ? 0.34 : kind === 1 ? 0.2 : kind === 3 ? 0.14 : 0.16) * vel * w) / 127;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + (kind === 1 ? 0.04 : kind === 3 ? 0.03 : 0.015));
    g.gain.linearRampToValueAtTime(a * 0.8, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
    o.connect(lp).connect(g).connect(this.spat.lead.input);
    if (kind === 1) this.noiseBurst(t, this.spat.lead.input, 3500, a * 0.12, 0.09);
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
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
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
    this.heard("ride", vel, 0.3);
    for (const [kind, w] of this.mix("ride")) if (w > 0.02) this.rideVoice(kind, w, t, vel, decayScale);
  }

  private rideVoice(kind: number, w: number, t: number, vel: number, decayScale: number): void {
    const peak = (0.3 * vel * w) / 127;
    if (kind === 1) {
      // brushes: a soft, low swish with no ping
      this.noiseBurst(t, this.spat.ride.input, 1800, peak * 1.1, 0.16 * decayScale + 0.12, 3600);
      return;
    }
    if (kind === 2) {
      // closed hat: short and bright
      this.noiseBurst(t, this.spat.ride.input, 7500, peak * 0.8, 0.06 * decayScale + 0.03);
      return;
    }
    this.noiseBurst(t, this.spat.ride.input, 5000, peak, 0.45 * decayScale + 0.1, 8500);
    const ctx = this.ctx;
    const ping = ctx.createOscillator();
    const g = ctx.createGain();
    ping.frequency.value = 5200;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak * 0.25, t + 0.002);
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

  /** Bass drum: a sine that falls from 120 to 45 Hz, placed with the bass. */
  private kick(t: number, vel: number): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    this.send(CH.drums, 36, vel, t, 0.2);
    this.heard("ride", vel, 0.25);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((0.5 * vel) / 127, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.28);
    o.connect(g).connect(this.spat.bass.input);
    o.start(t);
    o.stop(t + 0.3);
  }

  /** Snare: a noise burst over a short 190 Hz body. */
  /**
   * Snare with a different character on nearly every hit: soft ghost notes are low and brushy, loud hits sometimes crack as a
   * rimshot, medium ones now and then get a flam, and tone shifts the whole drum up or down (fills tune it).
   */
  private snare(t: number, vel: number, tone = 1): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    const ghost = vel < 30;
    const r = Math.random();
    const rimshot = !ghost && vel > 85 && r < 0.4;
    const flam = !ghost && vel > 50 && r > 0.9;
    this.send(CH.drums, rimshot ? 40 : 38, vel, t, 0.15);
    this.heard("ride", vel, 0.25);
    if (flam) this.snareHit(t - 0.03, vel * 0.4, tone * 0.96, false, false);
    this.snareHit(t, vel, tone, rimshot, ghost);
  }

  private snareHit(t: number, vel: number, tone: number, rimshot: boolean, ghost: boolean): void {
    const wob = 0.92 + Math.random() * 0.16;
    const hp = (ghost ? 1000 : 1300 + vel * 9) * tone * wob;
    this.noiseBurst(t, this.spat.ride.input, hp, ((ghost ? 0.3 : 0.4) * vel) / 127, ghost ? 0.2 : 0.11 + Math.random() * 0.1, rimshot ? 3200 : undefined);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f0 = (ghost ? 170 : 200 + vel * 0.5) * tone * wob;
    o.type = ghost ? "sine" : "triangle";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((0.25 * vel) / 127, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + (ghost ? 0.07 : 0.12));
    o.connect(g).connect(this.spat.ride.input);
    o.start(t);
    o.stop(t + 0.14);
    if (rimshot) {
      const c = this.ctx.createOscillator();
      const cg = this.ctx.createGain();
      c.type = "square";
      c.frequency.value = 1750 * tone;
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.linearRampToValueAtTime((0.08 * vel) / 127, t + 0.001);
      cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
      c.connect(cg).connect(this.spat.ride.input);
      c.start(t);
      c.stop(t + 0.04);
    }
  }

  /** A tom for the fills: a sine that falls in pitch. */
  private tom(t: number, vel: number, midi: number): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    this.send(CH.drums, midi, vel, t, 0.2);
    this.heard("ride", vel, 0.3);
    const f = mtof(midi) * 2.2;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(f * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((0.4 * vel) / 127, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.35);
    o.connect(g).connect(this.spat.ride.input);
    o.start(t);
    o.stop(t + 0.4);
    this.noiseBurst(t, this.spat.ride.input, 900, (0.12 * vel) / 127, 0.05);
  }

  /** Rim click, the bossa clave. */
  private rim(t: number, vel: number): void {
    vel = Math.round(vel * this.lv.ride);
    if (vel < 2) return;
    this.send(CH.drums, 37, vel, t, 0.05);
    this.heard("ride", vel, 0.15);
    this.noiseBurst(t, this.spat.ride.input, 2500, (0.3 * vel) / 127, 0.03, 1800);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = 1700;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((0.15 * vel) / 127, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.04);
    o.connect(g).connect(this.spat.ride.input);
    o.start(t);
    o.stop(t + 0.05);
  }
}
