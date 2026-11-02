// Styles, chord library, groove templates and the brain's personality (what it has learnt about playing).
//
// A style is a complete way of playing: swing amount, tempo, bass pattern, comping rhythm, drum groove, the kind of lead
// phrases (walking lines, fast bebop runs, 16th-note bursts, funk riffs) and its own chord progressions. The band picks
// the style from the state of the layers ("auto") or follows the style selector. How well it plays a style is the
// Personality: it grows with playing time, with tank coherence and with the Yes / No of the human.

import { clamp } from "./model";

export interface Chord {
  readonly name: string;
  readonly root: number; // MIDI note of the bass root
  readonly bass: readonly number[]; // chord tones above the root, in semitones
  readonly voicing: readonly number[]; // rootless comping voicing, MIDI notes
  readonly scale: readonly number[]; // pitch classes of the improvisation scale
  readonly quality?: QualityKey; // set for chords built from the library, used by the harmonic planner
}

interface Quality {
  readonly suffix: string;
  readonly bass: readonly number[];
  readonly voicing: readonly number[]; // intervals above the root
  readonly scale: readonly number[]; // intervals above the root
}

const QUALITIES = {
  m9: { suffix: "m9", bass: [0, 3, 7, 10], voicing: [3, 7, 10, 14], scale: [0, 2, 3, 5, 7, 9, 10] },
  m11: { suffix: "m11", bass: [0, 3, 7, 10], voicing: [10, 15, 17, 19], scale: [0, 2, 3, 5, 7, 9, 10] },
  m7b5: { suffix: "m7b5", bass: [0, 3, 6, 10], voicing: [3, 6, 10, 15], scale: [0, 2, 3, 5, 6, 8, 10] },
  dom7: { suffix: "7", bass: [0, 4, 7, 10], voicing: [4, 7, 10, 16], scale: [0, 2, 4, 5, 7, 9, 10] },
  dom9: { suffix: "9", bass: [0, 4, 7, 10], voicing: [4, 10, 14, 19], scale: [0, 2, 4, 5, 7, 9, 10] },
  dom13: { suffix: "13", bass: [0, 4, 7, 10], voicing: [4, 10, 14, 21], scale: [0, 2, 4, 5, 7, 9, 10] },
  alt: { suffix: "7b9b13", bass: [0, 4, 8, 10], voicing: [4, 10, 13, 20], scale: [0, 1, 3, 4, 6, 8, 10] },
  maj9: { suffix: "maj9", bass: [0, 4, 7, 11], voicing: [4, 7, 11, 14], scale: [0, 2, 4, 5, 7, 9, 11] },
  maj11: { suffix: "maj7#11", bass: [0, 4, 7, 11], voicing: [4, 11, 14, 18], scale: [0, 2, 4, 6, 7, 9, 11] },
} as const satisfies Record<string, Quality>;
export type QualityKey = keyof typeof QUALITIES;

const NOTE = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

function build(rootPc: number, q: QualityKey): Chord {
  const spec = QUALITIES[q];
  const root = 36 + ((((rootPc - 36) % 12) + 12) % 12);
  const base = 48 + ((((rootPc - 48) % 12) + 12) % 12);
  let notes = spec.voicing.map((i) => base + i);
  while ((notes[0] ?? 60) < 58) notes = notes.map((n) => n + 12);
  while ((notes[notes.length - 1] ?? 70) > 82) notes = notes.map((n) => n - 12);
  return { name: `${NOTE[rootPc % 12]}${spec.suffix}`, root, bass: spec.bass, voicing: notes, scale: spec.scale.map((i) => (rootPc + i) % 12), quality: q };
}

/** A library chord on any root pitch class, for substitutions and approach chords. */
export function chordFrom(rootPc: number, q: QualityKey): Chord {
  return build(((rootPc % 12) + 12) % 12, q);
}

// Four chords of two bars each (an eight-bar loop). [root pitch class, quality when resolved, quality when tense].
type Prog = readonly (readonly [number, QualityKey, QualityKey?])[];

export type StyleId = "brain" | "swing" | "bebop" | "fusion" | "funk" | "bossa" | "baroque";
export const STYLE_IDS: readonly StyleId[] = ["brain", "swing", "bebop", "fusion", "funk", "bossa", "baroque"];

export interface StyleDef {
  readonly id: StyleId;
  readonly name: string;
  readonly swing: number; // swing of the eighth-note grid at full skill, 0 straight .. 1 triplet
  readonly tempo: number; // multiplier of the tempo slider
  readonly bass: "walk" | "funk" | "bossa" | "arp" | "field";
  readonly comp: "charleston" | "chicken" | "bossa" | "none" | "field";
  readonly drums: "swing" | "funk" | "bossa" | "fusion" | "none" | "field";
  readonly lead: "swing" | "bebop" | "fusion" | "funk" | "theme" | "baroque";
  readonly lick: number; // chance that a bar is a phrase (lick / riff) instead of the plain layer-read theme
  readonly progs: readonly Prog[];
}

export const STYLES: Record<StyleId, StyleDef> = {
  // No preset patterns at all: rhythm is read from each tank's own oscillation (every Mth crest of its measured
  // frequency, placed where the crest really falls), accents from the sand bed, the chords measured from the layers'
  // pitches. The progs below are only a fallback for code paths that ask for a table.
  brain: {
    id: "brain", name: "From the brain", swing: 0.45, tempo: 1, bass: "field", comp: "field", drums: "field", lead: "theme", lick: 0.3,
    progs: [
      [[2, "m9"], [7, "dom13"], [0, "maj9"], [9, "dom9"]],
    ],
  },
  swing: {
    id: "swing", name: "Swing", swing: 0.92, tempo: 1, bass: "walk", comp: "charleston", drums: "swing", lead: "swing", lick: 0.55,
    progs: [
      [[2, "m9"], [7, "dom13"], [0, "maj9", "maj11"], [9, "dom13", "alt"]],
      [[0, "maj9"], [9, "dom7", "alt"], [2, "m9"], [7, "dom13"]],
      [[0, "m9"], [5, "dom13"], [10, "maj9"], [3, "maj9", "maj11"]],
      [[5, "dom9"], [10, "dom7"], [5, "dom9"], [7, "dom7", "alt"]],
    ],
  },
  bebop: {
    id: "bebop", name: "Bebop", swing: 0.85, tempo: 1.3, bass: "walk", comp: "charleston", drums: "swing", lead: "bebop", lick: 0.92,
    progs: [
      [[4, "m7b5"], [9, "alt"], [2, "m9"], [7, "dom13", "alt"]],
      [[2, "m9"], [7, "dom13", "alt"], [0, "maj9"], [9, "alt"]],
      [[7, "m9"], [0, "dom13", "alt"], [5, "maj9"], [2, "alt"]],
    ],
  },
  fusion: {
    id: "fusion", name: "Fusion", swing: 0.4, tempo: 1.08, bass: "funk", comp: "chicken", drums: "fusion", lead: "fusion", lick: 0.8,
    progs: [
      [[0, "m11"], [5, "dom13"], [0, "m11"], [8, "maj11"]],
      [[2, "m11"], [4, "m11"], [5, "maj11"], [4, "m11"]],
      [[10, "m11"], [3, "dom9"], [10, "m11"], [3, "dom9", "alt"]],
    ],
  },
  funk: {
    id: "funk", name: "Funk", swing: 0.14, tempo: 1.02, bass: "funk", comp: "chicken", drums: "funk", lead: "funk", lick: 0.9,
    progs: [
      [[4, "dom9"], [4, "dom9"], [9, "dom9"], [4, "dom9"]],
      [[9, "m9"], [2, "dom9"], [9, "m9"], [2, "dom9"]],
      [[7, "m11"], [7, "m11"], [0, "dom9"], [0, "dom9"]],
    ],
  },
  bossa: {
    id: "bossa", name: "Bossa", swing: 0.06, tempo: 0.88, bass: "bossa", comp: "bossa", drums: "bossa", lead: "theme", lick: 0.2,
    progs: [
      [[0, "maj9"], [9, "alt"], [2, "m9"], [7, "dom13"]],
      [[9, "m9"], [2, "dom13"], [7, "maj9"], [7, "maj11"]],
    ],
  },
  // Bach's ingredients: straight time, a running bass, sequences along the circle of fifths, ornaments and a canon.
  baroque: {
    id: "baroque", name: "Baroque", swing: 0, tempo: 0.95, bass: "arp", comp: "none", drums: "none", lead: "baroque", lick: 0.95,
    progs: [
      [[9, "m9"], [2, "m9"], [7, "dom7"], [0, "maj9"]],
      [[0, "maj9"], [5, "maj9"], [11, "m7b5"], [4, "dom7", "alt"]],
      [[2, "m9"], [7, "dom7"], [0, "maj9"], [9, "dom7", "alt"]],
    ],
  },
};

/** The four chords of progression `n` of a style; `tension` (0..1) chooses between the resolved and the altered colour. */
export function progressionOf(style: StyleId, n: number, tension: number): readonly Chord[] {
  const progs = STYLES[style].progs;
  const prog = progs[((n % progs.length) + progs.length) % progs.length] ?? progs[0] ?? [];
  return prog.map(([root, calm, tense]) => build(root, tense && tension >= 0.42 ? tense : calm));
}

export function progressionCount(style: StyleId): number {
  return STYLES[style].progs.length;
}

// ---- groove templates: 16 sixteenth-note slots per bar ----

/** Funk / fusion bass: 1 root, o octave, 5 fifth, 7 flat seven, g ghost (dead) root. */
export const FUNK_BASS: readonly string[] = ["1..g..1.o..g1.5.", "1.g.1..o..1.g.7.", "1..1..g.5..o.g7.", "1.o.g.1.5.g.o.7.", "1.......g.1...5.", "1..g.1.g1..5.g7o"];
/** Chicken-scratch comping: x stab, m muted short stab. */
export const CHICKEN: readonly string[] = [
  "x.mxm.x.m.xm.xm.", "m.xm.mx.m.xm.x.m", "x..x..x.m.x..mx.", "..x..x.m..x.mx.m",
  "x.m.m.xmx.m.m.x.", "mx.m.x.mm.xm.x.x", "x..m.x.mx..m.x.m", "m.x.x.m.xm.x.mx.",
];
/** Swing / bebop comping over two bars of eighth-note slots (16 slots): x stab, X longer accent. Charleston is the first. */
export const SWING_COMP: readonly string[] = [
  "x..x....x..x....", "..x..x....x..x..", "x.....x.x.....x.", ".x..x..x.x..x..x",
  "x...x...x...x...", "X..x...x..X.x...", "..x.x.x...x.x.x.", "x..x..x.x..x..x.",
];
/**
 * Strummed guitar over one bar of sixteenths: D down-strum of the whole chord, u up-strum of the top strings, x hard
 * accent, m muted chop, F flam (a soft grace down-strum a beat ahead of the main one), c chuck (a percussive all-string
 * mute slap, no pitch), . rest.
 */
export const STRUMS: readonly string[] = [
  "D..u.uD.D.uu.uD.", "D...D...D...D..u", "D.mu.umuD.mu.umu", "..x...x...x...x.",
  "x..m.mx..m.mx.m.", "D..D..D.D..D..D.", "D.u.m.uD..uD.m.u", "..D.u..D..D.u.D.",
  "D.......D..u....", "mDmDmDmDmDmDmDmD", "F..c.uD.F..c.uD.", "D.cu.cD.D.cu.cD.",
];
/** Kick patterns (k) and the places a ghost snare may sit. */
export const KICKS: readonly string[] = ["k..k..k...k..k..", "k.....k.k..k....", "k..k.k....k..k.k"];
export const GHOST_SLOTS: readonly number[] = [2, 7, 9, 14, 15];
/** Lead riff rhythms for funk and fusion (x = note). */
export const RIFF_RHYTHMS: readonly string[] = ["x..x.x..x.x..x..", "x.x..x.x....x.xx", "x..xx.x..x..x.x.", "..x.x.xx..x..x..", "x.xx..x.x..x.xx.", "x...x..xx...x.x."];
export const BOSSA_KICK = "k.....k.k.....k.";
export const BOSSA_CLAVE: readonly string[] = ["x.....x.....x...", "....x...x......."];

// ---- personality ----

const MAX_RHYTHMS = 28;
const STORE = "eftelaing-dust.brain.v1";

export interface PersonalityData {
  v: 1;
  seconds: number; // time spent playing
  bars: number;
  skill: number; // general fluency 0..1 (the feel of swing, pocket and phrasing)
  chops: number; // lick vocabulary 0..1
  liking: Record<StyleId, number>; // -1..1, what the human liked while this style played
  mastery: Record<StyleId, number>; // 0..1, practice per style
  lessons: number; // ratings received
  taste?: Record<string, number>; // -1..1 per pattern ("riff:3", "bass:1", "prog:funk:0"), from praise
  praised?: number;
  retries?: number;
  rhythms?: string[]; // the evolved pool of riff rhythms
  generation?: number;
  runs?: Record<string, number>; // how often each kind of run was played
}

const zero = (v: number): Record<StyleId, number> => ({ brain: v, swing: v, bebop: v, fusion: v, funk: v, bossa: v, baroque: v });

export class Personality {
  seconds = 0;
  bars = 0;
  skill = 0.3;
  chops = 0.3;
  lessons = 0;
  liking = zero(0);
  mastery = zero(0.15);
  /** What the human liked per pattern (riff rhythm, bass line, comping, kick, progression); biases what the band picks next. */
  taste: Record<string, number> = {};
  praised = 0;
  retries = 0;
  /** Riff rhythms, 16 slots each. Starts as the seed table and evolves while the band plays: see evolve(). */
  rhythms: string[] = [...RIFF_RHYTHMS];
  generation = 0;
  /** The human said "same tune again": the next style change is forced and a fresh progression is chosen. */
  restless = false;
  /** The human asked for a style by name ("Want funk"): the band moves there at the next chord change. */
  wanted: StyleId | null = null;
  private dirty = false;
  private lastSave = 0;

  constructor() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const d = JSON.parse(raw) as Partial<PersonalityData>;
        if (d.v === 1) {
          this.seconds = Number(d.seconds) || 0;
          this.bars = Number(d.bars) || 0;
          this.skill = clamp(Number(d.skill) || 0.3, 0, 1);
          this.chops = clamp(Number(d.chops) || 0.3, 0, 1);
          this.lessons = Number(d.lessons) || 0;
          for (const s of STYLE_IDS) {
            this.liking[s] = clamp(Number(d.liking?.[s]) || 0, -1, 1);
            this.mastery[s] = clamp(Number(d.mastery?.[s]) || 0.15, 0, 1);
          }
          this.praised = Number(d.praised) || 0;
          this.retries = Number(d.retries) || 0;
          this.generation = Number(d.generation) || 0;
          if (Array.isArray(d.rhythms)) {
            const ok = d.rhythms.filter((r): r is string => typeof r === "string" && /^[x.]{16}$/.test(r)).slice(0, MAX_RHYTHMS);
            if (ok.length >= 4) this.rhythms = ok;
          }
          for (const [k, v] of Object.entries(d.taste ?? {})) if (Number.isFinite(v)) this.taste[k] = clamp(v, -1, 1);
        }
      }
    } catch {
      // blocked storage: the brain then only learns for this session
    }
  }

  /** How fluently a style is played now, 0..1. */
  fluency(style: StyleId): number {
    return clamp(0.5 * this.skill + 0.5 * this.mastery[style], 0, 1);
  }

  /**
   * One bar of practice. `groove` (how locked the layers are to each other) and `health` (alignment and stability) decide how
   * much the brain takes in; `rate` is the learning-rate slider (0 freezes it).
   */
  practise(style: StyleId, groove: number, health: number, rate: number, barSeconds: number): void {
    this.bars++;
    this.seconds += barSeconds;
    const g = rate * (0.3 + 0.7 * health) * (0.3 + 0.7 * clamp(groove, 0, 1));
    this.skill += (1 - this.skill) * 0.004 * g;
    this.chops += (1 - this.chops) * 0.003 * g;
    this.mastery[style] += (1 - this.mastery[style]) * 0.008 * g;
    this.dirty = true;
    this.maybeSave();
  }

  /** The human's judgement of what is playing right now (style) and the hint chips ticked with it. */
  teach(style: StyleId, rating: number, hints: readonly string[], rate: number): void {
    this.lessons++;
    const r = clamp(rate, 0, 2);
    // -1 for hellish .. +1 for heavenly; "boring" and "no" are both negative, boring a little less.
    const score = rating >= 1.5 ? 1 : rating >= 1 ? 0.6 : rating >= 0.5 ? 0.1 : rating >= 0.25 ? -0.25 : rating >= 0 ? -0.5 : -1;
    this.liking[style] = clamp(this.liking[style] + 0.35 * score * r, -1, 1);
    for (const s of STYLE_IDS) if (s !== style) this.liking[s] *= 0.97;
    if (score > 0) {
      this.skill += (1 - this.skill) * 0.05 * score * r;
      this.mastery[style] += (1 - this.mastery[style]) * 0.1 * score * r;
    }
    if (hints.includes("noswing") || hints.includes("stiff") || hints.includes("mechanical") || hints.includes("groove")) {
      // "not swinging": the father asks for it, so the child practises the feel and leans towards the swinging styles
      this.skill += (1 - this.skill) * 0.03 * r;
      this.liking.swing = clamp(this.liking.swing + 0.12 * r, -1, 1);
      this.liking.bebop = clamp(this.liking.bebop + 0.06 * r, -1, 1);
    }
    if (hints.includes("noriffs")) this.chops += (1 - this.chops) * 0.06 * r;
    if (hints.includes("oldband") || hints.includes("samey")) this.restless = true;
    for (const h of hints) {
      const s = h.startsWith("want") ? (h.slice(4) as StyleId) : null;
      if (!s || !(s in this.liking)) continue;
      this.liking[s] = clamp(this.liking[s] + 0.4 * r, -1, 1);
      if (s !== style) this.wanted = s;
    }
    this.dirty = true;
    this.save();
  }

  /**
   * Sugar: the human says "nice" to what plays right now. `amount` (about 1 to 3, stacked by repeated clicks) raises the liking
   * of the style, the taste for every pattern that was sounding, and the skills a little. Learning never stops.
   */
  reward(style: StyleId, amount: number, keys: readonly string[], rate: number): void {
    const a = clamp(amount, 0, 3) * clamp(rate, 0.25, 2);
    this.praised++;
    this.restless = false;
    this.liking[style] = clamp(this.liking[style] + 0.1 * a, -1, 1);
    this.skill += (1 - this.skill) * 0.015 * a;
    this.chops += (1 - this.chops) * 0.01 * a;
    this.mastery[style] += (1 - this.mastery[style]) * 0.03 * a;
    for (const k of keys) this.taste[k] = clamp((this.taste[k] ?? 0) + 0.25 * a, -1, 1);
    this.dirty = true;
    this.save();
  }

  /**
   * "Try again": no punishment. Skill and mastery never go down; the patterns that were sounding are just a little less
   * likely to come back, and the band gets curious about something else.
   */
  retry(style: StyleId, amount: number, keys: readonly string[], rate: number): void {
    const a = clamp(amount, 0, 3) * clamp(rate, 0.25, 2);
    this.retries++;
    this.restless = a >= 1.5;
    this.liking[style] = clamp(this.liking[style] - 0.03 * a, -1, 1);
    for (const k of keys) this.taste[k] = clamp((this.taste[k] ?? 0) - 0.15 * a, -1, 1);
    this.dirty = true;
    this.save();
  }

  /** The human plays along (scratches the tanks): the brain watches and picks up a little vocabulary. */
  watch(): void {
    this.chops += (1 - this.chops) * 0.0008;
    this.dirty = true;
  }

  /** Picks one of n patterns named prefix0..prefix(n-1); `u` is a 0..1 sample, liked patterns get more weight. */
  pick(prefix: string, n: number, u: number): number {
    const w = Array.from({ length: n }, (_, i) => Math.exp(1.6 * (this.taste[`${prefix}${i}`] ?? 0)));
    let x = clamp(u, 0, 0.9999) * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) {
      x -= w[i] ?? 0;
      if (x < 0) return i;
    }
    return n - 1;
  }

  /**
   * Evolution of the riff vocabulary: a rhythm is picked (liked ones more often), a few of its steps are flipped, shifted or
   * mirrored, and the child joins the pool. When the pool is full the least liked (never the newest) is replaced and its taste
   * forgotten. Liked riffs get "nice" praise and survive; over hours of playing the pool drifts away from the seed table.
   * `rate` (0..1) is the Evolution slider; u1..u3 are random numbers in 0..1.
   */
  evolve(rate: number, u1: number, u2: number, u3: number): string | null {
    if (rate <= 0) return null;
    const parent = this.rhythms[this.pick("riff:", this.rhythms.length, u1)] ?? "x..x.x..x.x..x..";
    const cells = parent.split("");
    const op = u2 * 4;
    if (op < 2) {
      const flips = 1 + Math.floor(u3 * 3);
      for (let k = 0; k < flips; k++) {
        const i = (Math.floor((u3 * 977 + k * 5.3 + u2 * 131) * 16) + k * 7) % 16;
        cells[i] = cells[i] === "x" ? "." : "x";
      }
    } else if (op < 3) {
      const sh = 1 + Math.floor(u3 * 3);
      const r = parent.slice(-sh) + parent.slice(0, -sh);
      cells.splice(0, 16, ...r.split(""));
    } else {
      cells.splice(0, 16, ...parent.split("").reverse());
      cells[0] = "x";
    }
    const hits = cells.filter((c) => c === "x").length;
    if (hits < 4 || hits > 11) return null;
    const child = cells.join("");
    if (this.rhythms.includes(child)) return null;
    if (this.rhythms.length < MAX_RHYTHMS) this.rhythms.push(child);
    else {
      let worst = 0;
      for (let i = 0; i < this.rhythms.length - 1; i++) if ((this.taste[`riff:${i}`] ?? 0) < (this.taste[`riff:${worst}`] ?? 0)) worst = i;
      this.rhythms[worst] = child;
      delete this.taste[`riff:${worst}`];
    }
    this.generation++;
    this.dirty = true;
    return child;
  }

  /** What the brain has become so far, as a word. */
  stage(): string {
    const m = (this.skill + this.chops) / 2;
    return m < 0.3 ? "child" : m < 0.5 ? "student" : m < 0.7 ? "sideman" : m < 0.88 ? "soloist" : "bandleader";
  }

  describe(style: StyleId): string {
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const likes = STYLE_IDS.filter((s) => this.liking[s] > 0.15)
      .sort((a, b) => this.liking[b] - this.liking[a])
      .map((s) => STYLES[s].name.toLowerCase());
    return `${this.stage()} · ${Math.round(this.seconds / 60)} min played · swing skill ${pct(this.skill)} · licks ${pct(this.chops)} · ${STYLES[style].name} mastery ${pct(this.mastery[style])}${likes.length ? ` · you liked: ${likes.join(", ")}` : ""}${this.praised + this.retries > 0 ? ` · nice ${this.praised}× / try again ${this.retries}×` : ""} · ${this.rhythms.length} riff rhythms, generation ${this.generation}`;
  }

  clear(): void {
    this.seconds = 0;
    this.bars = 0;
    this.skill = 0.3;
    this.chops = 0.3;
    this.lessons = 0;
    this.liking = zero(0);
    this.mastery = zero(0.15);
    this.taste = {};
    this.praised = 0;
    this.retries = 0;
    this.save();
  }

  private maybeSave(): void {
    const now = Date.now();
    if (this.dirty && now - this.lastSave > 20000) this.save();
  }

  save(): void {
    this.lastSave = Date.now();
    this.dirty = false;
    const data: PersonalityData = { v: 1, seconds: this.seconds, bars: this.bars, skill: this.skill, chops: this.chops, liking: this.liking, mastery: this.mastery, lessons: this.lessons, taste: this.taste, praised: this.praised, retries: this.retries, rhythms: this.rhythms, generation: this.generation };
    try {
      localStorage.setItem(STORE, JSON.stringify(data));
    } catch {
      // see constructor
    }
  }
}
