// Coupled wave-field simulation: one n-dimensional "ripple tank" per OSI+ layer.

import { MAX_OPS, type GpuOp, type GpuSolver } from "./gpu";
import { NUM_LAYERS, NUM_LEVELS, clamp, defaultMapping, type Dimension, type Params } from "./model";

const GRID: Record<Dimension, readonly [number, number, number]> = {
  1: [192, 1, 1],
  2: [56, 56, 1],
  3: [20, 20, 20],
};

const TARGET_RMS = 0.15;
const MAX_COUPLING = 0.08;
const MAX_LEARNED = 0.12; // learned gains may push a link past the innate ceiling, but not without limit
const GAIN_MIN = 0.5;
const GAIN_MAX = 2;
const BED0 = 0.5; // initial (flat) sand height; the bed is a conserved quantity
const BED_MAX = 1.2; // soft capacity: sand cannot be pushed into cells that are already this full
const SAND_EVERY = 3; // sim steps per sand step (sand is slow)
const SAND_KAPPA = 2.5; // how strongly a sand dune raises the coupling between two layers at that spot
const SAND_REWARD = 2; // sand transport per unit of reward hormone and coherence difference

/** Where the learning lives: a gain per link, the sand beds (a coupling field per cell), or both. */
export type MemoryMode = "gain" | "sand" | "both";

export type Vec3 = [number, number, number];

function gauss(): number {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.7;
}

export class Simulation {
  dim: Dimension = 2;
  nx = 56;
  ny = 56;
  nz = 1;
  size = this.nx * this.ny * this.nz;
  u: Float32Array[] = [];
  v: Float32Array[] = [];
  ctx = new Float32Array(0);
  t = 0;

  // Sand bed per layer: height map over the (x, y) plane, shared by all z slices. Mass-conserving.
  plane = this.nx * this.ny;
  bed: Float32Array[] = [];
  private energy: Float32Array[] = [];
  private cscale: Float32Array[] = [];
  private delta = new Float32Array(0);
  private delta2 = new Float32Array(0);
  private sandPhase = 0;
  readonly cen = new Float32Array(NUM_LAYERS * 3).fill(0.5); // energy centroid (x, y, z) in 0..1 per layer

  // Per-frame observables
  readonly rms = new Float32Array(NUM_LAYERS);
  readonly stability = new Float32Array(NUM_LAYERS).fill(1);
  readonly vitality = new Float32Array(NUM_LAYERS);
  readonly lock = new Float32Array(NUM_LAYERS); // phase lock between layer i and i+1
  readonly fulfilment = new Float32Array(NUM_LEVELS);
  readonly availability = new Float32Array(NUM_LEVELS);
  readonly freq = new Float32Array(NUM_LAYERS); // rms angular frequency per step, smoothed
  readonly crest = new Float32Array(NUM_LAYERS); // peak / rms of the field, smoothed
  readonly spikes = new Float32Array(NUM_LAYERS); // spike magnitude detected at the last observe(), else 0
  readonly spikeCount = new Uint32Array(NUM_LAYERS);
  readonly need = new Float32Array(NUM_LEVELS * NUM_LAYERS);
  readonly activity = new Float32Array(NUM_LEVELS * NUM_LAYERS);
  mapping = defaultMapping();
  alignment = 0;
  /** A muted layer's tank is decoupled and damped to silence (sand stays, only the water stops): a true "what if we switch
   *  this layer off" experiment, not a mix-level mute, so you can hear and see whether the band really follows the layers. */
  readonly muted: boolean[] = new Array(NUM_LAYERS).fill(false);
  private readonly vel = new Float32Array(NUM_LAYERS);

  /**
   * Learned wiring. Link l joins layer l and l+1; its coupling is the innate coupling times gain[l] (1 = innate). A reward
   * hormone (`dopa`, positive for "nice", negative for "try again") gates a three-factor rule: the link changes in proportion
   * to the hormone and to its eligibility trace (how phase-locked the two layers have been lately). The hormone is cleared
   * within seconds, the wiring forgets slowly, and "try again" also rolls the wiring part of the way back.
   */
  readonly gain = new Float32Array(NUM_LAYERS).fill(1);
  dopa = 0;
  rewards = 0;
  private readonly elig = new Float32Array(NUM_LAYERS);
  private focus = -1;
  private focusUntil = 0;
  private readonly past: Float32Array[] = [];
  private pastClock = 0;

  /**
   * Sand memory. Between layer l and l+1 the coupling at cell i is multiplied by cpl[l][i], which grows where the sand of both
   * beds is piled up and shrinks in their hollows (the stack is a 3D medium, x and y plus the layer axis, whose vertical
   * conductivity is carved in sand). `corr[l]` is a trace of how in-phase the two layers are at each cell. A reward hormone
   * carries sand towards cells where the layers cooperate (a negative one away from them); mass is conserved, only redistributed.
   */
  memory: MemoryMode = "sand";
  private cpl: Float32Array[] = [];
  private corr: Float32Array[] = [];
  private pastBeds: Float32Array[][] = [];

  // GPU solver (see gpu.ts): while attached, the fields live on the GPU and u/v are a mirror that arrives a frame or two late.
  private gpu: GpuSolver | null = null;
  private gpuOps: GpuOp[] = [];
  private gpuSteps = 0;
  private gpuParams: Params | null = null;

  private painPos: Vec3 = [0.5, 0.5, 0.5];
  private painUntil = 0;

  constructor(dim: Dimension = 2) {
    this.setDimension(dim);
  }

  setDimension(dim: Dimension): void {
    this.dim = dim;
    [this.nx, this.ny, this.nz] = GRID[dim];
    this.size = this.nx * this.ny * this.nz;
    this.u = Array.from({ length: NUM_LAYERS }, () => new Float32Array(this.size));
    this.v = Array.from({ length: NUM_LAYERS }, () => new Float32Array(this.size));
    this.ctx = new Float32Array(this.size);
    this.plane = this.nx * this.ny;
    this.bed = Array.from({ length: NUM_LAYERS }, () => new Float32Array(this.plane).fill(BED0));
    this.energy = Array.from({ length: NUM_LAYERS }, () => new Float32Array(this.plane));
    this.cscale = Array.from({ length: NUM_LAYERS }, () => new Float32Array(this.plane).fill(1));
    this.delta = new Float32Array(this.plane);
    this.delta2 = new Float32Array(this.plane);
    this.cpl = Array.from({ length: NUM_LAYERS - 1 }, () => new Float32Array(this.plane).fill(1));
    this.corr = Array.from({ length: NUM_LAYERS - 1 }, () => new Float32Array(this.plane));
    this.pastBeds = [];
    this.rms.fill(0);
    this.stability.fill(1);
    this.gpuOps = [];
    this.gpuSteps = 0;
    this.gpu?.configure(this.nx, this.ny, this.nz);
    this.gpu?.upload(this.u, this.v);
    this.gpu?.setMirror(this.u, this.v);
  }

  get solver(): "gpu" | "cpu" {
    return this.gpu ? "gpu" : "cpu";
  }

  /** Moves the solving of the wave fields to the GPU. The CPU keeps a mirror of u and v for everything that reads them. */
  attachGpu(g: GpuSolver): void {
    this.gpu = g;
    g.configure(this.nx, this.ny, this.nz);
    g.upload(this.u, this.v);
    g.setMirror(this.u, this.v);
    this.gpuOps = [];
    this.gpuSteps = 0;
  }

  /** Back to the CPU solver; the mirror (at most a couple of frames old) becomes the truth. */
  detachGpu(): void {
    this.gpu = null;
    this.gpuOps = [];
    this.gpuSteps = 0;
  }

  private pushOp(op: Omit<GpuOp, "step">): void {
    if (this.gpuOps.length < MAX_OPS) this.gpuOps.push({ ...op, step: this.gpuSteps });
  }

  /** Sends this frame's steps and finger writes to the GPU. Call once per animation frame. A lost device falls back to the CPU. */
  flushGpu(p: Params): void {
    const g = this.gpu;
    if (!g) return;
    if (g.lost) {
      this.detachGpu();
      return;
    }
    const co = this.coefficients(this.gpuParams ?? p);
    g.run({ ops: this.gpuOps, steps: this.gpuSteps, layer: co.layer, kCtx: co.kCtx, cscale: this.cscale, cpl: this.cpl, ctx: this.ctx });
    this.gpuOps = [];
    this.gpuSteps = 0;
  }

  // Levels the sand of one layer (or all): same mass, flat surface.
  flattenSand(layer?: number): void {
    for (let l = 0; l < NUM_LAYERS; l++) {
      if (layer !== undefined && l !== layer) continue;
      const b = this.bed[l];
      if (b) b.fill(this.sandMass(l) / this.plane);
      this.cscale[l]?.fill(1);
    }
  }

  // Redistributes the sand of every layer into random smooth dunes. The total mass per layer is unchanged.
  seedSand(): void {
    for (let l = 0; l < NUM_LAYERS; l++) {
      const b = this.bed[l];
      if (!b) continue;
      const mean = this.sandMass(l) / this.plane;
      const g = new Float32Array(this.plane);
      const blobs = 10 + ((Math.random() * 8) | 0);
      for (let k = 0; k < blobs; k++) {
        const cx = Math.random() * (this.nx - 1);
        const cy = this.ny > 1 ? Math.random() * (this.ny - 1) : 0;
        const sg = (this.nx / 14) * (0.6 + Math.random());
        const amp = (Math.random() < 0.5 ? -1 : 1) * 0.35 * mean * (0.5 + Math.random());
        const inv = 1 / (2 * sg * sg);
        for (let y = 0; y < this.ny; y++) {
          for (let x = 0; x < this.nx; x++) {
            g[x + y * this.nx] = (g[x + y * this.nx] ?? 0) + amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) * inv);
          }
        }
      }
      let gm = 0;
      for (let i = 0; i < this.plane; i++) gm += g[i] ?? 0;
      gm /= this.plane;
      for (let i = 0; i < this.plane; i++) b[i] = Math.max(0.01, mean + (g[i] ?? 0) - gm);
      // Clamping removed or added a little mass: put it back uniformly.
      const err = (mean * this.plane - this.sandMass(l)) / this.plane;
      for (let i = 0; i < this.plane; i++) b[i] = Math.max(0, (b[i] ?? 0) + err);
    }
  }

  sandMass(layer: number): number {
    const b = this.bed[layer];
    let m = 0;
    if (b) for (let i = 0; i < this.plane; i++) m += b[i] ?? 0;
    return m;
  }

  // Standard deviation of the bed height: 0 = flat.
  sandRelief(layer: number): number {
    const b = this.bed[layer];
    if (!b) return 0;
    const mean = this.sandMass(layer) / this.plane;
    let s = 0;
    for (let i = 0; i < this.plane; i++) s += ((b[i] ?? 0) - mean) ** 2;
    return Math.sqrt(s / this.plane);
  }

  // Waves transport sand: from agitated water towards still water (acoustic streaming, as in Chladni figures),
  // while gravity relaxes slopes. All transport is face-to-face flux, so the total sand mass is exactly conserved.
  // The bed height in turn sets the local wave speed (shallow = slow).
  private sandStep(p: Params): void {
    const { nx, ny, nz, plane } = this;
    const kE = p.sandErosion * 0.15;
    const kL = p.sandLevel * 0.12;
    const delta = this.delta;
    const useSand = this.memory !== "gain";
    this.updateCorrelation(); // also feeds the 3D view, whatever the memory mode
    const attend = this.t < this.focusUntil ? this.focus : -1;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      const v = this.v[l];
      const bed = this.bed[l];
      const e = this.energy[l];
      const cs = this.cscale[l];
      if (!u || !v || !bed || !e || !cs) continue;
      const w = 1 / this.omega(l);
      const inv = 1 / nz;
      for (let i = 0; i < plane; i++) {
        let acc = 0;
        for (let z = 0; z < nz; z++) {
          const k = i + z * plane;
          const uu = u[k] ?? 0;
          const vv = (v[k] ?? 0) * w;
          acc += uu * uu + vv * vv;
        }
        e[i] = (e[i] ?? 0) * 0.95 + acc * inv * 0.05;
      }
      // Reward hormone: sand climbs the gradient of "where my neighbour layers cooperate with me".
      const rk = useSand && this.dopa !== 0 ? SAND_REWARD * this.dopa * (attend >= 0 && (l === attend || l === attend - 1 || l === attend + 1) ? 2 : 1) : 0;
      const ca = l > 0 ? this.corr[l - 1] : undefined;
      const cb = l < NUM_LAYERS - 1 ? this.corr[l] : undefined;
      const target = rk !== 0 ? this.delta2 : undefined;
      if (target) for (let i = 0; i < plane; i++) target[i] = ((ca?.[i] ?? 0) + (cb?.[i] ?? 0)) / ((ca ? 1 : 0) + (cb ? 1 : 0));
      if (kE > 0 || kL > 0 || target) {
        delta.fill(0);
        const face = (i: number, j: number): void => {
          const bi = bed[i] ?? 0;
          const bj = bed[j] ?? 0;
          let f = kL * (bi - bj);
          if (kE > 0) {
            const ei = e[i] ?? 0;
            const ej = e[j] ?? 0;
            const tot = ei + ej;
            const rel = (ei - ej) / (tot + 1e-6);
            const gate = 1 - Math.exp(-tot / 0.01);
            const k = kE * gate * rel;
            f += k > 0 ? k * bi * Math.max(0, 1 - bj / BED_MAX) : k * bj * Math.max(0, 1 - bi / BED_MAX);
          }
          if (target) {
            const d = clamp(rk * ((target[i] ?? 0) - (target[j] ?? 0)), -0.2, 0.2);
            f -= d > 0 ? d * bj * Math.max(0, 1 - bi / BED_MAX) : d * bi * Math.max(0, 1 - bj / BED_MAX);
          }
          delta[i] = (delta[i] ?? 0) - f;
          delta[j] = (delta[j] ?? 0) + f;
        };
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx - 1; x++) face(x + y * nx, x + 1 + y * nx);
        }
        for (let y = 0; y < ny - 1; y++) {
          for (let x = 0; x < nx; x++) face(x + y * nx, x + (y + 1) * nx);
        }
        for (let i = 0; i < plane; i++) bed[i] = Math.max(0, (bed[i] ?? 0) + (delta[i] ?? 0));
      }
      if (p.sandDepth > 0) {
        let mean = 0;
        for (let i = 0; i < plane; i++) mean += bed[i] ?? 0;
        mean /= plane;
        for (let i = 0; i < plane; i++) cs[i] = clamp(1 - p.sandDepth * 1.5 * ((bed[i] ?? 0) - mean), 0.35, 1.6);
      } else {
        cs.fill(1);
      }
    }
    if (useSand) this.updateCoupling();
  }

  /** Trace of how in-phase layer l and l+1 are at each cell (-1..1), gated by how much wave energy is there. */
  private updateCorrelation(): void {
    const { plane, nz } = this;
    for (let l = 0; l < NUM_LAYERS - 1; l++) {
      const a = this.u[l];
      const b = this.u[l + 1];
      const c = this.corr[l];
      if (!a || !b || !c) continue;
      for (let i = 0; i < plane; i++) {
        let num = 0;
        let den = 0;
        for (let z = 0; z < nz; z++) {
          const x = a[i + z * plane] ?? 0;
          const y = b[i + z * plane] ?? 0;
          num += x * y;
          den += x * x + y * y;
        }
        const inst = (2 * num) / (den + 1e-9) * (1 - Math.exp(-den / (0.004 * nz)));
        c[i] = (c[i] ?? 0) * 0.97 + 0.03 * inst;
      }
    }
  }

  /** The coupling field carved by the sand: above-average sand in both beds opens the link at that cell, hollows close it. */
  private updateCoupling(): void {
    const { plane } = this;
    const mean = (b: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < plane; i++) s += b[i] ?? 0;
      return Math.max(s / plane, 1e-6);
    };
    for (let l = 0; l < NUM_LAYERS - 1; l++) {
      const a = this.bed[l];
      const b = this.bed[l + 1];
      const c = this.cpl[l];
      if (!a || !b || !c) continue;
      const ma = mean(a);
      const mb = mean(b);
      for (let i = 0; i < plane; i++) c[i] = clamp(Math.exp(SAND_KAPPA * (0.5 * ((a[i] ?? 0) / ma + (b[i] ?? 0) / mb) - 1)), 0.3, 2.5);
    }
  }

  reset(): void {
    for (let l = 0; l < NUM_LAYERS; l++) {
      this.u[l]?.fill(0);
      this.v[l]?.fill(0);
      this.energy[l]?.fill(0);
    }
    this.t = 0;
    this.gpuOps = [];
    this.gpuSteps = 0;
    this.gpu?.upload(this.u, this.v);
  }

  omega(layer: number): number {
    return 0.05 * Math.pow(2, layer / 3);
  }

  private sigma(): number {
    return this.dim === 1 ? 3 : this.dim === 2 ? 2.6 : 1.7;
  }

  // Adds a gaussian bump around a normalised position into the given field.
  private bump(layer: number, isV: boolean, pos: Vec3, sigma: number, amp: number): void {
    if (this.muted[layer]) return; // a switched-off layer takes no energy from any source: drives, fire, or scratch
    const { nx, ny, nz } = this;
    const cx = pos[0] * (nx - 1);
    const cy = ny > 1 ? pos[1] * (ny - 1) : 0;
    const cz = nz > 1 ? pos[2] * (nz - 1) : 0;
    const r = Math.ceil(sigma * 2.5);
    const inv = 1 / (2 * sigma * sigma);
    const x0 = Math.max(nx > 1 ? 1 : 0, Math.floor(cx - r));
    const x1 = Math.min(nx > 1 ? nx - 2 : 0, Math.ceil(cx + r));
    const y0 = Math.max(ny > 1 ? 1 : 0, Math.floor(cy - r));
    const y1 = Math.min(ny > 1 ? ny - 2 : 0, Math.ceil(cy + r));
    const z0 = Math.max(nz > 1 ? 1 : 0, Math.floor(cz - r));
    const z1 = Math.min(nz > 1 ? nz - 2 : 0, Math.ceil(cz + r));
    if (this.gpu) {
      this.pushOp({ layer, isV, kind: 0, amp, cx, cy, cz, inv, x0, x1, y0, y1, z0, z1 });
      return;
    }
    const field = isV ? this.v[layer] : this.u[layer];
    if (!field) return;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
          const i = x + nx * (y + ny * z);
          field[i] = (field[i] ?? 0) + amp * Math.exp(-d2 * inv);
        }
      }
    }
  }

  // Strikes a layer: a displacement bump plus an outgoing velocity kick.
  fire(layer: number, pos?: Vec3, amp = 1): void {
    const p: Vec3 = pos ?? [0.2 + 0.6 * Math.random(), 0.2 + 0.6 * Math.random(), 0.2 + 0.6 * Math.random()];
    if (this.u[layer]) this.bump(layer, false, p, this.sigma() * 1.3, amp);
  }

  // Finger in the water: a small gaussian dent at a normalised position, meant to be called along a drag path.
  scratch(layer: number, pos: Vec3, amp = 0.1): void {
    if (this.u[layer]) this.bump(layer, false, pos, this.sigma() * 0.6, amp);
  }

  // Reverse mapping: strike every OSI layer that a Maslow level maps to.
  fireLevel(level: number): void {
    for (let l = 0; l < NUM_LAYERS; l++) {
      const w = this.mapping[level * NUM_LAYERS + l] ?? 0;
      if (w > 0) this.fire(l, undefined, w);
    }
  }

  private standing(layer: number, amp: number): void {
    if (this.muted[layer]) return;
    const { nx, ny, nz } = this;
    if (this.gpu) {
      this.pushOp({ layer, isV: true, kind: 1, amp, cx: 0, cy: 0, cz: 0, inv: 0, x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 });
      return;
    }
    const field = this.v[layer];
    if (!field) return;
    for (let z = 0; z < nz; z++) {
      const pz = nz > 1 ? Math.sin((Math.PI * z) / (nz - 1)) : 1;
      for (let y = 0; y < ny; y++) {
        const py = ny > 1 ? Math.sin((Math.PI * y) / (ny - 1)) : 1;
        for (let x = 0; x < nx; x++) {
          const i = x + nx * (y + ny * z);
          field[i] = (field[i] ?? 0) + amp * Math.sin((Math.PI * x) / (nx - 1)) * py * pz;
        }
      }
    }
  }

  private driveGain(): number {
    return this.dim === 1 ? 0.3 : this.dim === 2 ? 1 : 3;
  }

  private kick(layer: number, pos: Vec3, sigma: number, amp: number): void {
    this.bump(layer, true, pos, sigma, amp * this.driveGain());
  }

  private applyDrives(p: Params): void {
    const t = this.t;
    const s = this.sigma();
    const psy = p.psychedelic;
    const g = this.driveGain();

    for (let l = 0; l < 7; l++) {
      if (p.instrumentDrive <= 0) continue;
      const ph = l * 0.9;
      this.kick(l, [0.5 + 0.28 * Math.cos(ph), 0.5 + 0.28 * Math.sin(ph), 0.5], s, p.instrumentDrive * 0.03 * Math.sin(this.omega(l) * t));
    }

    if (p.playerActivity > 0) {
      const w = this.omega(7);
      const a = p.playerActivity * 0.04 * Math.sin(w * t);
      this.kick(7, [0.5 + 0.3 * Math.cos(0.004 * t), 0.5 + 0.3 * Math.sin(0.004 * t), 0.5], s, a);
      this.kick(7, [0.5 - 0.3 * Math.cos(0.004 * t), 0.5 - 0.3 * Math.sin(0.004 * t), 0.5], s, -a);
    }

    if (p.directorIntent > 0) {
      const phrase = 0.5 + 0.5 * Math.sin(0.002 * t);
      this.kick(9, [0.5, 0.5, 0.5], s * 1.4, p.directorIntent * 0.05 * phrase * Math.sin(this.omega(9) * t));
    }

    // The Mind (L9): pain, delight, interest, curiosity, ecstasy.
    {
      const w = this.omega(8);
      if (p.pain > 0) {
        if (t >= this.painUntil) {
          this.painPos = [0.15 + 0.7 * Math.random(), 0.15 + 0.7 * Math.random(), 0.15 + 0.7 * Math.random()];
          this.painUntil = t + 25 + Math.random() * 40;
        }
        this.kick(8, this.painPos, s * 0.7, p.pain * 0.3 * Math.sin(w * 2.4 * t));
      }
      if (p.delight > 0) this.kick(8, [0.5, 0.5, 0.5], s * 1.6, p.delight * 0.08 * Math.sin(w * t));
      if (p.interest > 0) this.kick(8, [0.7, 0.35, 0.5], s * 0.9, p.interest * 0.08 * Math.sin(w * 0.5 * t));
      if (p.curiosity > 0) {
        const pos: Vec3 = [0.5 + 0.35 * Math.sin(0.011 * t), 0.5 + 0.35 * Math.sin(0.017 * t + 1), 0.5 + 0.3 * Math.sin(0.007 * t + 2)];
        this.kick(8, pos, s, p.curiosity * 0.06 * Math.sin(w * 1.5 * t));
      }
      if (p.ecstasy > 0) this.standing(8, g * p.ecstasy * 0.03 * Math.sin(w * t) * (0.6 + 0.4 * Math.sin(0.003 * t)));
    }

    // Dust is injected only at the Director (L10); lower layers receive it through top-down coupling.
    if (p.dust > 0) {
      const sprinkles = Math.max(1, Math.round(p.dust * 24));
      const gain = g * p.dust * 0.12 * (1 + psy);
      for (let k = 0; k < sprinkles; k++) {
        const i = (Math.random() * this.size) | 0;
        if (this.gpu) {
          this.pushOp({ layer: NUM_LAYERS - 1, isV: true, kind: 2, amp: gain * gauss(), cx: 0, cy: 0, cz: 0, inv: i, x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 });
        } else {
          const top = this.v[NUM_LAYERS - 1];
          if (top) top[i] = (top[i] ?? 0) + gain * gauss();
        }
      }
    }

    // Maslow -> OSI: unmet needs push the under-active layers they map to.
    if (p.reverseGain > 0) {
      for (let l = 0; l < NUM_LAYERS; l++) {
        const need = this.layerNeed(l);
        if (need < 0.02 || (this.rms[l] ?? 0) > TARGET_RMS * 1.3) continue;
        const ph = l * 0.9 + 0.5;
        this.kick(l, [0.5 + 0.25 * Math.cos(ph), 0.5 + 0.25 * Math.sin(ph), 0.5], s, p.reverseGain * 0.05 * need * Math.sin(this.omega(l) * t));
      }
    }
  }

  private layerNeed(l: number): number {
    let sum = 0;
    let wsum = 0;
    for (let m = 0; m < NUM_LEVELS; m++) {
      const w = this.mapping[m * NUM_LAYERS + l] ?? 0;
      sum += w * (this.availability[m] ?? 1) * (1 - (this.fulfilment[m] ?? 0));
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  /**
   * A shot of reward hormone: `amount` > 0 is "nice", < 0 is "try again". `focus` is the layer (0..9) the human is looking at
   * or scratching; the links next to it learn faster, as attention does.
   */
  reward(amount: number, focus = -1): void {
    this.rewards++;
    this.dopa = clamp(this.dopa + amount, -2.5, 4);
    this.focus = focus;
    this.focusUntil = this.t + 1200;
    if (amount < 0 && this.past.length > 0) {
      // Try again: the wiring goes part of the way back to how it was some seconds ago.
      const old = this.past[Math.max(0, this.past.length - 6)];
      if (old) for (let l = 0; l < NUM_LAYERS; l++) this.gain[l] = (this.gain[l] ?? 1) + 0.35 * Math.min(1, -amount) * ((old[l] ?? 1) - (this.gain[l] ?? 1));
    }
    if (amount < 0 && this.memory !== "gain") {
      // The sand slides part of the way back to how the beds lay some seconds ago (same mass, so nothing is lost).
      const old = this.pastBeds[Math.max(0, this.pastBeds.length - 6)];
      const f = 0.35 * Math.min(1, -amount);
      if (old) {
        for (let l = 0; l < NUM_LAYERS; l++) {
          const b = this.bed[l];
          const o = old[l];
          if (b && o && b.length === o.length) for (let i = 0; i < b.length; i++) b[i] = (b[i] ?? 0) + f * ((o[i] ?? 0) - (b[i] ?? 0));
        }
        this.updateCoupling();
      }
    }
  }

  /** Chooses where the learning lives. Switching away from the sand leaves the beds as they are, but they stop steering the coupling. */
  setMemory(mode: MemoryMode): void {
    this.memory = mode;
    if (mode === "gain") for (const c of this.cpl) c.fill(1);
    else this.updateCoupling();
  }

  /**
   * How strongly the links are coupled where it matters: the learned gain of the link in gain mode, or, in sand mode, the
   * coupling at the cells where the two layers have recently been in phase (1 = innate).
   */
  learned(l: number): number {
    const g = this.memory === "sand" ? 1 : this.gain[l] ?? 1;
    if (this.memory === "gain") return g;
    const c = this.cpl[l];
    const r = this.corr[l];
    if (!c || !r) return g;
    let num = 0;
    let den = 0;
    for (let i = 0; i < c.length; i++) {
      const w = Math.max(0, r[i] ?? 0);
      num += w * (c[i] ?? 1);
      den += w;
    }
    return g * (den > 1e-6 ? num / den : 1);
  }

  /** The coupling field of link l (between layer l and l+1) over the tank plane, 1 = innate. */
  couplingMap(l: number): Float32Array | undefined {
    return this.cpl[l];
  }

  /** How in-phase layer l and l+1 have recently been at each cell of the plane (-1..1). */
  coherenceMap(l: number): Float32Array | undefined {
    return this.corr[l];
  }

  /** The sand memory as bytes (one per cell, per layer), for keeping it between sessions. */
  exportSand(): string {
    const bytes = new Uint8Array(NUM_LAYERS * this.plane);
    for (let l = 0; l < NUM_LAYERS; l++) {
      const b = this.bed[l];
      if (b) for (let i = 0; i < this.plane; i++) bytes[l * this.plane + i] = Math.round(clamp((b[i] ?? 0) / BED_MAX, 0, 1) * 255);
    }
    let bin = "";
    for (const x of bytes) bin += String.fromCharCode(x);
    return btoa(bin);
  }

  importSand(text: string): void {
    const bin = atob(text);
    if (bin.length !== NUM_LAYERS * this.plane) return;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const b = this.bed[l];
      if (!b) continue;
      let sum = 0;
      for (let i = 0; i < this.plane; i++) {
        b[i] = (bin.charCodeAt(l * this.plane + i) / 255) * BED_MAX;
        sum += b[i] ?? 0;
      }
      const k = (BED0 * this.plane) / Math.max(sum, 1e-6); // quantisation must not create or destroy sand
      for (let i = 0; i < this.plane; i++) b[i] = (b[i] ?? 0) * k;
    }
    this.updateCoupling();
  }

  /** Forgets everything the tanks learned: the wiring is innate again. */
  forgetWiring(): void {
    this.gain.fill(1);
    this.past.length = 0;
    this.pastBeds = [];
    for (const c of this.corr) c.fill(0);
    this.flattenSand();
    this.updateCoupling();
    this.elig.fill(0);
    this.dopa = 0;
  }

  private learn(dt: number): void {
    const n = NUM_LAYERS - 1;
    const a = 1 - Math.exp(-dt / 4);
    let mean = 0;
    for (let l = 0; l < n; l++) {
      this.elig[l] = (this.elig[l] ?? 0) + a * ((this.lock[l] ?? 0) - (this.elig[l] ?? 0));
      mean += (this.elig[l] ?? 0) / n;
    }
    this.dopa *= Math.exp(-dt / 6);
    if (Math.abs(this.dopa) < 0.005) this.dopa = 0;
    const attend = this.t < this.focusUntil ? this.focus : -1;
    for (let l = 0; l < n; l++) {
      const near = attend >= 0 && (l === attend || l === attend - 1) ? 2.5 : 1;
      let g = this.gain[l] ?? 1;
      if (this.memory !== "sand") g += 0.008 * dt * this.dopa * near * ((this.elig[l] ?? 0) / Math.max(mean, 0.05));
      g += (1 - g) * (1 - Math.exp(-dt / 900));
      this.gain[l] = clamp(g, GAIN_MIN, GAIN_MAX);
    }
    this.pastClock += dt;
    if (this.pastClock >= 2) {
      this.pastClock = 0;
      this.past.push(Float32Array.from(this.gain));
      if (this.past.length > 15) this.past.shift();
      if (this.memory !== "gain") {
        this.pastBeds.push(this.bed.map((b) => Float32Array.from(b)));
        if (this.pastBeds.length > 15) this.pastBeds.shift();
      }
    }
  }

  /**
   * Per-layer constants of one step: c2, gamma, ks, kU, kD, then flags for the sand scale and the two sand couplings.
   * Up/down couplings are made energy-consistent (geometric layer masses) by bounding their ratio; a fully one-way chain
   * would be an active, runaway-prone system. Shared by the CPU loop and the GPU kernel.
   */
  private coefficients(p: Params): { layer: Float32Array; kCtx: number } {
    const nAxes = (this.nx > 1 ? 1 : 0) + (this.ny > 1 ? 1 : 0) + (this.nz > 1 ? 1 : 0);
    const psy = p.psychedelic;
    const upRaw = 0.02 * p.couplingUp ** 2 * (1 + 3 * psy);
    const downRaw = 0.02 * p.couplingDown ** 2 * (1 + 3 * psy);
    const hi = Math.max(upRaw, downRaw);
    const kUp = Math.min(MAX_COUPLING, Math.max(upRaw, hi * 0.5));
    const kDown = Math.min(MAX_COUPLING, Math.max(downRaw, hi * 0.5));
    const stab = p.stabilization * (1 - 0.7 * psy);
    const out = new Float32Array(NUM_LAYERS * 8);
    for (let l = 0; l < NUM_LAYERS; l++) {
      const sPrev = l === 0 ? 1 : this.stability[l - 1] ?? 1;
      const cf = 0.3 + 0.3 * (l / (NUM_LAYERS - 1));
      const gu = this.memory === "sand" ? 1 : this.gain[l - 1] ?? 1;
      const gd = this.memory === "sand" ? 1 : this.gain[l] ?? 1;
      const o = l * 8;
      out[o] = (cf * cf) / nAxes;
      out[o + 1] = p.damping + stab * 0.03 * sPrev;
      out[o + 2] = stab * 0.004 * sPrev;
      out[o + 3] = l > 0 ? Math.min(MAX_LEARNED, kUp * gu) : 0;
      out[o + 4] = l < NUM_LAYERS - 1 ? Math.min(MAX_LEARNED, kDown * gd) : 0;
      out[o + 5] = p.sandDepth > 0 ? 1 : 0;
      out[o + 6] = this.memory !== "gain" && l > 0 ? 1 : 0;
      out[o + 7] = this.memory !== "gain" && l < NUM_LAYERS - 1 ? 1 : 0;
    }
    // A muted layer loses its own wave speed and both couplings (so it decays smoothly to flat and stops driving
    // anything), and its neighbours lose the coupling that would otherwise pull energy from it, so it is cleanly out of
    // the stack. The damping/restoring values are hand-tuned to the explicit step below: strong enough to flatten in
    // well under a second, not so strong that the discrete update overshoots and rings (large damping can do that).
    for (let l = 0; l < NUM_LAYERS; l++) {
      if (!this.muted[l]) continue;
      const o = l * 8;
      out[o] = 0;
      out[o + 1] = 0.4;
      out[o + 2] = 0.06;
      out[o + 3] = 0;
      out[o + 4] = 0;
      if (l > 0) out[(l - 1) * 8 + 4] = 0;
      if (l < NUM_LAYERS - 1) out[(l + 1) * 8 + 3] = 0;
    }
    return { layer: out, kCtx: 0.03 * psy };
  }

  step(p: Params): void {
    this.applyDrives(p);
    if (this.gpu) {
      this.gpuParams = p;
      this.gpuSteps++;
      this.t += 1;
      if (++this.sandPhase >= SAND_EVERY) {
        this.sandPhase = 0;
        this.sandStep(p);
      }
      return;
    }

    const { nx, ny, nz } = this;
    const sx = 1;
    const sy = nx;
    const sz = nx * ny;
    const x0 = nx > 1 ? 1 : 0;
    const x1 = nx > 1 ? nx - 1 : 1;
    const y0 = ny > 1 ? 1 : 0;
    const y1 = ny > 1 ? ny - 1 : 1;
    const z0 = nz > 1 ? 1 : 0;
    const z1 = nz > 1 ? nz - 1 : 1;
    const hasX = nx > 1;
    const hasY = ny > 1;
    const hasZ = nz > 1;
    const { layer: co, kCtx } = this.coefficients(p);
    const ctx = this.ctx;

    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      const v = this.v[l];
      if (!u || !v) continue;
      const below = l > 0 ? this.u[l - 1] : undefined;
      const above = l < NUM_LAYERS - 1 ? this.u[l + 1] : undefined;
      const c2 = co[l * 8] ?? 0;
      const gamma = co[l * 8 + 1] ?? 0;
      const ks = co[l * 8 + 2] ?? 0;
      const kU = co[l * 8 + 3] ?? 0;
      const kD = co[l * 8 + 4] ?? 0;
      const cs = co[l * 8 + 5] ? this.cscale[l] : undefined;
      const cplU = co[l * 8 + 6] ? this.cpl[l - 1] : undefined;
      const cplD = co[l * 8 + 7] ? this.cpl[l] : undefined;

      for (let z = z0; z < z1; z++) {
        for (let y = y0; y < y1; y++) {
          let i = x0 + y * sy + z * sz;
          for (let x = x0; x < x1; x++, i++) {
            const c = u[i] ?? 0;
            let lap = 0;
            if (hasX) lap += (u[i - sx] ?? 0) + (u[i + sx] ?? 0) - 2 * c;
            if (hasY) lap += (u[i - sy] ?? 0) + (u[i + sy] ?? 0) - 2 * c;
            if (hasZ) lap += (u[i - sz] ?? 0) + (u[i + sz] ?? 0) - 2 * c;
            let a = (cs ? c2 * (cs[x + y * nx] ?? 1) : c2) * lap - ks * c - gamma * (v[i] ?? 0);
            const pi = x + y * nx;
            if (below) a += (cplU ? Math.min(MAX_LEARNED, kU * (cplU[pi] ?? 1)) : kU) * ((below[i] ?? 0) - c);
            if (above) a += (cplD ? Math.min(MAX_LEARNED, kD * (cplD[pi] ?? 1)) : kD) * ((above[i] ?? 0) - c);
            if (kCtx > 0) a += kCtx * ((ctx[i] ?? 0) - c);
            v[i] = (v[i] ?? 0) + a;
          }
        }
      }
    }

    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      const v = this.v[l];
      if (!u || !v) continue;
      for (let i = 0; i < this.size; i++) {
        let nu = (u[i] ?? 0) + (v[i] ?? 0);
        if (nu > 2) {
          nu = 2;
          v[i] = 0;
        } else if (nu < -2) {
          nu = -2;
          v[i] = 0;
        }
        u[i] = nu;
      }
      // Dirichlet walls
      this.pinBoundary(u, v);
    }
    this.t += 1;
    if (++this.sandPhase >= SAND_EVERY) {
      this.sandPhase = 0;
      this.sandStep(p);
    }
  }

  private pinBoundary(u: Float32Array, v: Float32Array): void {
    const { nx, ny, nz } = this;
    if (this.dim === 1) {
      u[0] = u[nx - 1] = 0;
      v[0] = v[nx - 1] = 0;
      return;
    }
    // Only the outer shell can have been touched by bump() or coupling.
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const edge = x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || (nz > 1 && (z === 0 || z === nz - 1));
          if (!edge) {
            x = nx - 2; // skip interior run of this row
            continue;
          }
          const i = x + nx * (y + ny * z);
          u[i] = 0;
          v[i] = 0;
        }
      }
    }
  }

  private updateContext(mode: Params["context"]): void {
    const { nx, ny, nz, ctx, t } = this;
    const beat = Math.pow(Math.max(0, Math.sin(0.03 * t)), 4);
    for (let z = 0; z < nz; z++) {
      const pz = nz > 1 ? z / (nz - 1) : 0.5;
      for (let y = 0; y < ny; y++) {
        const py = ny > 1 ? y / (ny - 1) : 0.5;
        for (let x = 0; x < nx; x++) {
          const px = nx > 1 ? x / (nx - 1) : 0.5;
          const r = Math.hypot(px - 0.5, py - 0.5, pz - 0.5);
          let val = 0;
          switch (mode) {
            case "rest":
              val = 0.05 * Math.sin(0.01 * t) * Math.sin(Math.PI * px) * Math.sin(Math.PI * py);
              break;
            case "meditation":
              val = 0.25 * Math.cos(2 * Math.PI * 1.5 * r - 0.02 * t) * Math.exp(-1.2 * r);
              break;
            case "music": {
              val = 0.25 * Math.sin(2 * Math.PI * 2 * px) * Math.sin(0.07 * t);
              if (ny > 1) val += 0.2 * Math.sin(2 * Math.PI * 3 * py) * Math.sin(0.11 * t) * (0.4 + beat);
              if (nz > 1) val += 0.15 * Math.sin(2 * Math.PI * 2 * pz) * Math.sin(0.05 * t);
              break;
            }
            case "movie":
              for (let k = 0; k < 3; k++) {
                const cx = 0.5 + 0.35 * Math.sin(0.006 * t * (k + 1) + k);
                const cy = 0.5 + 0.35 * Math.cos(0.005 * t * (k + 2) + 2 * k);
                const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - 0.5) ** 2;
                val += 0.4 * Math.exp(-d2 / 0.02) * (k % 2 === 0 ? 1 : -1);
              }
              break;
          }
          ctx[x + nx * (y + ny * z)] = val;
        }
      }
    }
  }

  // Energy-weighted centre of the field, used to place the layer's voice in the auditory scene.
  private updateCentroid(l: number, u: Float32Array, s2: number): void {
    const { nx, ny, nz } = this;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        let row = 0;
        for (let x = 0; x < nx; x++) {
          const a = u[x + nx * (y + ny * z)] ?? 0;
          const w = a * a;
          row += w;
          cx += w * x;
        }
        cy += row * y;
        cz += row * z;
      }
    }
    const set = (k: number, v: number): void => {
      this.cen[l * 3 + k] = (this.cen[l * 3 + k] ?? 0.5) * 0.85 + v * 0.15;
    };
    set(0, nx > 1 ? cx / s2 / (nx - 1) : 0.5);
    set(1, ny > 1 ? cy / s2 / (ny - 1) : 0.5);
    set(2, nz > 1 ? cz / s2 / (nz - 1) : 0.5);
  }

  // Recomputes the slow observables: rms, stability chain, vitality, Maslow fulfilment, context alignment.
  // `dt` is the real time since the last call in seconds; it sets the speed of the hormone and the learning.
  observe(p: Params, dt = 1 / 30): void {
    this.learn(dt);
    this.updateContext(p.context);
    const n = this.size;
    let ctxNorm = 0;
    for (let i = 0; i < n; i++) ctxNorm += (this.ctx[i] ?? 0) ** 2;
    ctxNorm = Math.sqrt(ctxNorm) + 1e-9;

    let align = 0;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      if (!u) continue;
      const v = this.v[l];
      let s2 = 0;
      let sv2 = 0;
      let peak = 0;
      let dot = 0;
      for (let i = 0; i < n; i++) {
        const x = u[i] ?? 0;
        const y = v?.[i] ?? 0;
        s2 += x * x;
        sv2 += y * y;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        dot += x * (this.ctx[i] ?? 0);
      }
      const rms = Math.sqrt(s2 / n);
      this.rms[l] = (this.rms[l] ?? 0) * 0.8 + rms * 0.2;
      if (s2 > 1e-6) this.updateCentroid(l, u, s2);

      // Monitor features: spectral centre (rms omega = |v|/|u|), crest factor and velocity-jump spikes.
      const vrms = Math.sqrt(sv2 / n);
      if (rms > 1e-4) {
        const w = clamp(vrms / rms, 0.01, 1);
        this.freq[l] = (this.freq[l] ?? 0) * 0.85 + w * 0.15;
        this.crest[l] = (this.crest[l] ?? 0) * 0.85 + clamp(peak / rms, 1, 12) * 0.15;
      }
      const ref = this.vel[l] ?? 0;
      const threshold = 1.3 + 2 * (1 - p.spikeSens);
      const isSpike = vrms > 0.004 && ref > 1e-5 && vrms > ref * threshold;
      this.spikes[l] = isSpike ? clamp(vrms / (ref * threshold), 1, 4) : 0;
      if (isSpike) this.spikeCount[l] = (this.spikeCount[l] ?? 0) + 1;
      this.vel[l] = ref === 0 ? vrms : ref * 0.9 + vrms * 0.1;
      align += Math.abs(dot) / (Math.sqrt(s2) * ctxNorm + 1e-9);

      const next = this.u[l + 1];
      if (next) {
        let d = 0;
        let s2n = 0;
        for (let i = 0; i < n; i++) {
          const b = next[i] ?? 0;
          d += (u[i] ?? 0) * b;
          s2n += b * b;
        }
        this.lock[l] = clamp(Math.abs(d) / (Math.sqrt(s2 * s2n) + 1e-9), 0, 1);
      }
    }
    this.alignment = this.alignment * 0.8 + (align / NUM_LAYERS) * 0.2;

    let s = 1;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const r = this.rms[l] ?? 0;
      s *= 1 - 0.6 * Math.tanh((r / 0.6) ** 2);
      this.stability[l] = (this.stability[l] ?? 1) * 0.9 + s * 0.1;
      const lr = Math.log((r + 1e-4) / TARGET_RMS);
      this.vitality[l] = Math.exp(-(lr * lr) / 2);
    }

    // OSI -> Maslow: weighted vitality of the mapped layers, each scaled by the stability it receives from below.
    let avail = 1;
    for (let m = 0; m < NUM_LEVELS; m++) {
      let sum = 0;
      let wsum = 0;
      for (let l = 0; l < NUM_LAYERS; l++) {
        const w = this.mapping[m * NUM_LAYERS + l] ?? 0;
        const sBelow = l === 0 ? 1 : this.stability[l - 1] ?? 1;
        const a = w * (this.vitality[l] ?? 0) * sBelow;
        this.activity[m * NUM_LAYERS + l] = a;
        sum += a;
        wsum += w;
      }
      const f = wsum > 0 ? clamp(sum / wsum, 0, 1) : 0;
      this.availability[m] = avail;
      this.fulfilment[m] = (this.fulfilment[m] ?? 0) * 0.85 + f * avail * 0.15;
      avail = clamp(avail * (0.35 + 0.65 * Math.min(1, f * 1.5)), 0, 1);
    }
    for (let m = 0; m < NUM_LEVELS; m++) {
      for (let l = 0; l < NUM_LAYERS; l++) {
        const w = this.mapping[m * NUM_LAYERS + l] ?? 0;
        this.need[m * NUM_LAYERS + l] = w * (this.availability[m] ?? 1) * (1 - (this.fulfilment[m] ?? 0));
      }
    }
  }
}
