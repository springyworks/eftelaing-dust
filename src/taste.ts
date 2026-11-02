// Taste model: learns which slider settings the human likes from No / Maybe / Yes ratings.
//
// A Gaussian-process regression over the normalised slider vector (RBF kernel, per-slider relevance weights that are
// re-estimated from the ratings). Proposals are drawn by Monte Carlo: many random candidates (local moves of a few
// sliders, moves around liked settings, and global random jumps) are scored by "posterior mean + exploration x
// posterior uncertainty" and the best one is played next.

// Hellish and Heavenly are optional stronger answers: they extend the scale beyond No and Yes.
// Boring (0.25) means "not bad, just flat": it sits between No and Maybe.
export type Rating = -0.5 | 0 | 0.25 | 0.5 | 1 | 1.5; // Hellish, No, Boring, Maybe, Yes, Heavenly

export interface Sample {
  readonly x: Float64Array; // each entry in 0..1
  readonly y: Rating;
}

export interface Suggestion {
  readonly x: Float64Array;
  readonly mean: number;
  readonly std: number;
}

export interface SuggestOptions {
  readonly explore: number; // 0..1 weight of uncertainty
  readonly radius: number; // 0..1 size of local moves
  readonly moves: number; // how many sliders a local move touches
  readonly locked: readonly boolean[];
  readonly candidates?: number;
}

const MAX_SAMPLES = 220;
const NOISE = 0.04;
const MIN_FIT = 3;

function gaussian(): number {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.7;
}

export class TasteModel {
  samples: Sample[] = [];
  private weights: Float64Array;
  private chol: Float64Array = new Float64Array(0);
  private alpha: Float64Array = new Float64Array(0);
  private prior = 0.5;
  private readonly twoLs2: number; // 2 x squared length scale, grows with the number of sliders

  constructor(readonly dim: number) {
    this.twoLs2 = 2 * 0.0225 * dim;
    this.weights = new Float64Array(dim).fill(1);
  }

  get count(): number {
    return this.samples.length;
  }

  /** Learned relevance of each slider (mean 1): how strongly the ratings depend on it. */
  get relevance(): Float64Array {
    return this.weights;
  }

  add(x: ArrayLike<number>, y: Rating): void {
    this.samples.push({ x: Float64Array.from(x), y });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.fit();
  }

  clear(): void {
    this.samples = [];
    this.weights.fill(1);
    this.fit();
  }

  private kernel(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let d = 0;
    for (let k = 0; k < this.dim; k++) {
      const t = (a[k] ?? 0) - (b[k] ?? 0);
      d += (this.weights[k] ?? 1) * t * t;
    }
    return Math.exp(-d / this.twoLs2);
  }

  private estimateRelevance(): void {
    const n = this.samples.length;
    if (n < 6) {
      this.weights.fill(1);
      return;
    }
    let my = 0;
    for (const s of this.samples) my += s.y;
    my /= n;
    let vy = 0;
    for (const s of this.samples) vy += (s.y - my) ** 2;
    const raw = new Float64Array(this.dim);
    let sum = 0;
    for (let k = 0; k < this.dim; k++) {
      let mx = 0;
      for (const s of this.samples) mx += s.x[k] ?? 0;
      mx /= n;
      let vx = 0;
      let c = 0;
      for (const s of this.samples) {
        const dx = (s.x[k] ?? 0) - mx;
        vx += dx * dx;
        c += dx * (s.y - my);
      }
      const r = vx > 1e-9 && vy > 1e-9 ? Math.abs(c) / Math.sqrt(vx * vy) : 0;
      // shrink towards 1 while there is little data
      const shrink = Math.min(1, n / 40);
      raw[k] = 0.4 + 2.2 * r * shrink;
      sum += raw[k] ?? 0;
    }
    for (let k = 0; k < this.dim; k++) this.weights[k] = ((raw[k] ?? 1) * this.dim) / sum;
  }

  private fit(): void {
    const n = this.samples.length;
    if (n === 0) {
      this.chol = new Float64Array(0);
      this.alpha = new Float64Array(0);
      this.prior = 0.5;
      return;
    }
    this.estimateRelevance();
    let m = 0;
    for (const s of this.samples) m += s.y;
    this.prior = 0.5 * 0.5 + 0.5 * (m / n);
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = this.kernel(this.samples[i]?.x ?? [], this.samples[j]?.x ?? []) + (i === j ? NOISE : 0);
        for (let k = 0; k < j; k++) sum -= (L[i * n + k] ?? 0) * (L[j * n + k] ?? 0);
        L[i * n + j] = i === j ? Math.sqrt(Math.max(sum, 1e-9)) : sum / (L[j * n + j] ?? 1);
      }
    }
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = (this.samples[i]?.y ?? 0) - this.prior;
    this.chol = L;
    this.alpha = this.solveUpper(L, this.solveLower(L, r));
  }

  private solveLower(L: Float64Array, b: Float64Array): Float64Array {
    const n = b.length;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i] ?? 0;
      for (let k = 0; k < i; k++) s -= (L[i * n + k] ?? 0) * (y[k] ?? 0);
      y[i] = s / (L[i * n + i] ?? 1);
    }
    return y;
  }

  private solveUpper(L: Float64Array, b: Float64Array): Float64Array {
    const n = b.length;
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i] ?? 0;
      for (let k = i + 1; k < n; k++) s -= (L[k * n + i] ?? 0) * (x[k] ?? 0);
      x[i] = s / (L[i * n + i] ?? 1);
    }
    return x;
  }

  /** Posterior mean (0 = surely No, 1 = surely Yes, -0.5 Hellish, 1.5 Heavenly) and standard deviation (0..1) for a setting. */
  predict(x: ArrayLike<number>): { mean: number; std: number } {
    const n = this.samples.length;
    if (n < MIN_FIT - 1) return { mean: 0.5, std: 1 };
    const ks = new Float64Array(n);
    let mean = this.prior;
    for (let i = 0; i < n; i++) {
      ks[i] = this.kernel(x, this.samples[i]?.x ?? []);
      mean += (ks[i] ?? 0) * (this.alpha[i] ?? 0);
    }
    const v = this.solveLower(this.chol, ks);
    let q = 0;
    for (let i = 0; i < n; i++) q += (v[i] ?? 0) ** 2;
    return { mean: Math.min(1.5, Math.max(-0.5, mean)), std: Math.sqrt(Math.max(0, 1 - q)) };
  }

  /** Monte Carlo search for the next setting to try. */
  suggest(current: ArrayLike<number>, o: SuggestOptions): Suggestion {
    const free: number[] = [];
    for (let k = 0; k < this.dim; k++) if (!o.locked[k]) free.push(k);
    const liked = this.samples.filter((s) => s.y > 0.6);
    const n = o.candidates ?? 240;
    const beta = 2.2 * o.explore;
    let best: Suggestion | null = null;
    let bestScore = -Infinity;
    for (let c = 0; c < n; c++) {
      const kind = Math.random();
      const x = Float64Array.from(current);
      if (kind < 0.55 || free.length === 0) {
        // local: nudge a few sliders
        const touch = Math.max(1, Math.min(free.length, Math.round(o.moves * (0.5 + Math.random()))));
        for (let t = 0; t < touch; t++) {
          const k = free[(Math.random() * free.length) | 0];
          if (k !== undefined) x[k] = clamp01((x[k] ?? 0) + gaussian() * (0.08 + 0.5 * o.radius));
        }
      } else if (kind < 0.8 && liked.length > 0) {
        // around a liked setting
        const base = liked[(Math.random() * liked.length) | 0]?.x ?? current;
        for (const k of free) x[k] = clamp01((base[k] ?? 0) + gaussian() * (0.04 + 0.2 * o.radius));
      } else {
        // global jump on a subset of sliders
        const touch = Math.max(1, Math.min(free.length, o.moves + 1));
        for (let t = 0; t < touch; t++) {
          const k = free[(Math.random() * free.length) | 0];
          if (k !== undefined) x[k] = Math.random();
        }
      }
      const pr = this.predict(x);
      const score = pr.mean + beta * pr.std;
      if (score > bestScore) {
        bestScore = score;
        best = { x, mean: pr.mean, std: pr.std };
      }
    }
    return best ?? { x: Float64Array.from(current), mean: 0.5, std: 1 };
  }

  /** The best setting the model knows: Monte Carlo search with no exploration bonus, started from liked samples. */
  favourite(o: Pick<SuggestOptions, "locked">, current: ArrayLike<number>): Suggestion | null {
    if (this.samples.length < MIN_FIT) return null;
    let best: Suggestion | null = null;
    const seeds = [...this.samples].sort((a, b) => b.y - a.y).slice(0, 12);
    for (const seed of seeds) {
      for (let c = 0; c < 40; c++) {
        const x = Float64Array.from(seed.x);
        for (let k = 0; k < this.dim; k++) {
          if (o.locked[k]) x[k] = current[k] ?? 0;
          else if (c > 0) x[k] = clamp01((x[k] ?? 0) + gaussian() * 0.05);
        }
        const pr = this.predict(x);
        if (!best || pr.mean > best.mean) best = { x, mean: pr.mean, std: pr.std };
      }
    }
    return best;
  }

  /** Per slider: mean position among Yes ratings and among No ratings (null while unrated). */
  profile(): { yes: (number | null)[]; no: (number | null)[] } {
    const yes: (number | null)[] = [];
    const no: (number | null)[] = [];
    for (let k = 0; k < this.dim; k++) {
      let ys = 0;
      let yw = 0;
      let ns = 0;
      let nw = 0;
      for (const s of this.samples) {
        const x = s.x[k] ?? 0;
        if (s.y > 0) {
          ys += x * s.y;
          yw += s.y;
        }
        if (s.y < 1) {
          ns += x * (1 - s.y);
          nw += 1 - s.y;
        }
      }
      yes.push(yw > 0 ? ys / yw : null);
      no.push(nw > 0 ? ns / nw : null);
    }
    return { yes, no };
  }

  toJSON(names: readonly string[]): string {
    return JSON.stringify({
      v: 1,
      names,
      samples: this.samples.map((s) => ({ x: Array.from(s.x, (t) => Math.round(t * 1e4) / 1e4), y: s.y })),
    });
  }

  /** Restores ratings saved with the same or a different slider set; unknown sliders are dropped, new ones start at 0.5. */
  load(json: string, names: readonly string[]): boolean {
    try {
      const data = JSON.parse(json) as { names?: string[]; samples?: { x: number[]; y: number }[] };
      if (!Array.isArray(data.names) || !Array.isArray(data.samples)) return false;
      const index = names.map((n) => (data.names as string[]).indexOf(n));
      this.samples = [];
      for (const s of data.samples) {
        if (s.y !== -0.5 && s.y !== 0 && s.y !== 0.25 && s.y !== 0.5 && s.y !== 1 && s.y !== 1.5) continue;
        const x = new Float64Array(this.dim);
        for (let k = 0; k < this.dim; k++) {
          const src = index[k] ?? -1;
          x[k] = src >= 0 ? clamp01(Number(s.x[src] ?? 0.5)) : 0.5;
        }
        this.samples.push({ x, y: s.y });
      }
      this.samples = this.samples.slice(-MAX_SAMPLES);
      this.fit();
      return true;
    } catch {
      return false;
    }
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
