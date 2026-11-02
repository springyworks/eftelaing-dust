// Auto-tuner for the human voice: pulls a sung note towards what the band plays right now, so singing along never
// clashes. The tune-in level says how hard it pulls; the harmonic colour (jazz) makes it relax: tensions and passing
// notes stay as they are, the way a jazz singer is allowed to lean on a 9th or a blue note.

export interface TuneChord {
  readonly root: number;
  readonly bass: readonly number[]; // chord tones above the root, in semitones
  readonly scale: readonly number[]; // pitch classes of the improvisation scale
}

export type TuneKind = "chord" | "scale" | "passing" | "free";

export interface Tuned {
  readonly midi: number;
  readonly kind: TuneKind;
  readonly shift: number; // semitones moved
}

const pc = (n: number): number => ((n % 12) + 12) % 12;

/** Strictness 0..1 from the tune-in level and the colour: jazzier is more relaxed. */
export function strictness(level: number, colour: number): number {
  return Math.min(1, Math.max(0, level)) * (1 - 0.7 * Math.min(1, Math.max(0, colour)));
}

/** The class of a pitch against the chord: a chord tone, a tone of the scale, or a chromatic passing note. */
export function classify(midi: number, c: TuneChord): TuneKind {
  const p = pc(midi);
  if (c.bass.some((i) => pc(c.root + i) === p)) return "chord";
  if (c.scale.some((s) => pc(s) === p)) return "scale";
  return "passing";
}

/**
 * Tunes one sung note. Every candidate within three semitones costs its distance plus a penalty for its class that grows
 * with the strictness, so a strict tuner jumps to a chord tone and a relaxed one leaves scale tones and tensions alone.
 */
export function tuneNote(midi: number, c: TuneChord, level: number, colour: number): Tuned {
  const s = strictness(level, colour);
  const m = Math.round(midi);
  if (s < 0.05) return { midi: m, kind: classify(m, c), shift: 0 };
  const penalty = { chord: 0, scale: 3 * s * s, passing: 6 * s, free: 6 * s } as const;
  let best = m;
  let bestCost = Infinity;
  for (let n = m - 3; n <= m + 3; n++) {
    const cost = Math.abs(n - midi) + penalty[classify(n, c)];
    if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) < 1e-9 && Math.abs(n - midi) < Math.abs(best - midi))) {
      bestCost = cost;
      best = n;
    }
  }
  return { midi: best, kind: classify(best, c), shift: best - m };
}
