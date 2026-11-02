// Harmony for the comping instruments: voice leading (the next chord is voiced as close as possible to the last one), a few
// ways to voice the same chord, and a harmonic plan with substitutions and approach chords whose probability follows a
// "heat" (a slow arc over 32 bars, pushed up by the activity of layer 6 and by the tension of the Maslow levels).

import { chordFrom, type Chord, type QualityKey } from "./style";

export const VOICING_NAMES = ["shell", "rootless", "spread", "upper structure", "guitar"] as const;
export const GUITAR_VOICING = 4;

const DOMINANT: ReadonlySet<QualityKey> = new Set<QualityKey>(["dom7", "dom9", "dom13", "alt"]);
const pc = (n: number): number => (((n % 12) + 12) % 12);
const unique = (a: readonly number[]): number[] => [...new Set(a)];

/** Ascending stack of the pitch classes, the first one at or above `start`. */
function stack(pcs: readonly number[], start: number): number[] {
  const out: number[] = [];
  let last = start - 1;
  for (const p of pcs) {
    const n = last + 1 + pc(p - (last + 1));
    out.push(n);
    last = n;
  }
  return out;
}

function pitchClasses(c: Chord, variant: number): number[] {
  const r = pc(c.root);
  const third = pc(r + (c.bass[1] ?? 4));
  const fifth = pc(r + (c.bass[2] ?? 7));
  const seventh = pc(r + (c.bass[3] ?? 10));
  const colour = c.voicing.map(pc);
  if (variant === 0) {
    const top = [...colour].reverse().find((x) => x !== third && x !== seventh) ?? fifth;
    return unique([third, seventh, top]);
  }
  if (variant === 3) return unique([fifth, seventh, ...colour.filter((x) => x !== third)]).slice(0, 4);
  if (variant === GUITAR_VOICING) {
    const top = [...colour].reverse().find((x) => x !== third && x !== seventh && x !== fifth && x !== r) ?? colour[colour.length - 1] ?? fifth;
    return unique([r, fifth, seventh, third, top]);
  }
  return unique(colour);
}

/**
 * Voices chord `c` in one of the ways of VOICING_NAMES. Except for the guitar shape (root position in the low register) the
 * inversion and octave are chosen to keep as many notes as possible where they were in `prev`, so chords move smoothly.
 */
export function voiceLead(c: Chord, prev: readonly number[], variant: number): number[] {
  const pcs = pitchClasses(c, variant);
  if (variant === GUITAR_VOICING) {
    const shape = stack(pcs, c.root < 40 ? c.root + 12 : c.root);
    return shape.length > 4 && (shape[shape.length - 1] ?? 0) > 72 ? shape.slice(0, -1) : shape;
  }
  const centre = 66;
  const lo = variant === 0 ? 55 : 53;
  const hi = variant === 2 ? 83 : 80;
  let best: number[] = [];
  let bestCost = Infinity;
  for (let rot = 0; rot < pcs.length; rot++) {
    const order = [...pcs.slice(rot), ...pcs.slice(0, rot)];
    for (let start = lo; start <= hi - 5; start++) {
      const cand = stack(order, start);
      const top = cand[cand.length - 1] ?? start;
      if (top > hi + 2) continue;
      const mean = cand.reduce((a, b) => a + b, 0) / cand.length;
      const span = top - (cand[0] ?? start);
      let cost = 0.25 * Math.abs(mean - centre) + (span > 16 ? (span - 16) * 1.5 : 0);
      if (prev.length > 0) cost += cand.reduce((a, n) => a + Math.min(...prev.map((p) => Math.abs(n - p))), 0) / cand.length;
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
  }
  if (variant === 2 && best.length >= 4) best[best.length - 2] = (best[best.length - 2] ?? 60) - 12;
  return best.sort((a, b) => a - b);
}

export interface ChordPlan {
  chord: Chord;
  approach: Chord | null;
  tag: string;
}

/**
 * What to play in place of `base` (followed by `next`): possibly a tritone substitution for a dominant, a richer colour, and
 * an approach chord (the dominant of the next chord, or a dominant a semitone above it) for the last two beats of the chord.
 * `heat` 0..1 sets how adventurous it is; u are three numbers in 0..1 taken from the layers.
 */
export function planChord(base: Chord, next: Chord, heat: number, u: readonly [number, number, number]): ChordPlan {
  let chord = base;
  const tags: string[] = [];
  const q = base.quality;
  if (q && DOMINANT.has(q) && u[0] < 0.08 + 0.4 * heat) {
    chord = chordFrom(pc(base.root + 6), q === "alt" ? "alt" : "dom9");
    tags.push(`tritone sub of ${base.name}`);
  } else if (q === "m9" && heat > 0.55 && u[2] > 0.6) {
    chord = chordFrom(pc(base.root), "m11");
    tags.push("m11 colour");
  } else if (q === "maj9" && heat > 0.7 && u[2] > 0.5) {
    chord = chordFrom(pc(base.root), "maj11");
    tags.push("#11 colour");
  }
  let approach: Chord | null = null;
  const nextPc = pc(next.root);
  if (u[2] < 0.1 + 0.55 * heat) {
    const chromatic = u[1] < 0.45;
    const rootPc = chromatic ? pc(nextPc + 1) : pc(nextPc + 7);
    if (rootPc !== pc(chord.root)) {
      approach = chordFrom(rootPc, chromatic || heat < 0.55 ? "dom9" : "alt");
      tags.push(`${approach.name} leads to ${next.name}`);
    }
  }
  return { chord, approach, tag: tags.join(", ") };
}

/** Slow arc over 32 bars (0 at the start, 1 in the middle) blended with layer 6 activity and Maslow tension. */
export function harmonicHeat(bar: number, l6: number, tension: number, brain: number): number {
  const arc = 0.5 - 0.5 * Math.cos((2 * Math.PI * (((bar % 32) + 32) % 32)) / 32);
  const act = Math.min(1, Math.max(0, l6 * 1.5));
  return Math.min(1, Math.max(0, 0.12 + 0.5 * arc + 0.35 * act * brain + 0.15 * tension));
}
