// Coupled wave-field simulation: one n-dimensional "ripple tank" per OSI+ layer.

import { MASLOW, NUM_LAYERS, clamp, type Dimension, type Params } from "./model";

const GRID: Record<Dimension, readonly [number, number, number]> = {
  1: [192, 1, 1],
  2: [56, 56, 1],
  3: [20, 20, 20],
};

const TARGET_RMS = 0.15;
const MAX_COUPLING = 0.08;

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

  // Per-frame observables
  readonly rms = new Float32Array(NUM_LAYERS);
  readonly stability = new Float32Array(NUM_LAYERS).fill(1);
  readonly vitality = new Float32Array(NUM_LAYERS);
  readonly lock = new Float32Array(NUM_LAYERS); // phase lock between layer i and i+1
  readonly fulfilment = new Float32Array(MASLOW.length);
  readonly availability = new Float32Array(MASLOW.length);
  alignment = 0;

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
    this.rms.fill(0);
    this.stability.fill(1);
  }

  reset(): void {
    for (let l = 0; l < NUM_LAYERS; l++) {
      this.u[l]?.fill(0);
      this.v[l]?.fill(0);
    }
    this.t = 0;
  }

  omega(layer: number): number {
    return 0.05 * Math.pow(2, layer / 3);
  }

  private sigma(): number {
    return this.dim === 1 ? 3 : this.dim === 2 ? 2.6 : 1.7;
  }

  // Adds a gaussian bump around a normalised position into the given field.
  private bump(field: Float32Array, pos: Vec3, sigma: number, amp: number): void {
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
  fire(layer: number, pos?: Vec3): void {
    const p: Vec3 = pos ?? [0.2 + 0.6 * Math.random(), 0.2 + 0.6 * Math.random(), 0.2 + 0.6 * Math.random()];
    const u = this.u[layer];
    if (u) this.bump(u, p, this.sigma() * 1.3, 1);
  }

  private standing(field: Float32Array, amp: number): void {
    const { nx, ny, nz } = this;
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

  private kick(field: Float32Array, pos: Vec3, sigma: number, amp: number): void {
    this.bump(field, pos, sigma, amp * this.driveGain());
  }

  private applyDrives(p: Params): void {
    const t = this.t;
    const s = this.sigma();
    const psy = p.psychedelic;
    const g = this.driveGain();

    for (let l = 0; l < 7; l++) {
      const f = this.v[l];
      if (!f || p.instrumentDrive <= 0) continue;
      const ph = l * 0.9;
      this.kick(f, [0.5 + 0.28 * Math.cos(ph), 0.5 + 0.28 * Math.sin(ph), 0.5], s, p.instrumentDrive * 0.03 * Math.sin(this.omega(l) * t));
    }

    const player = this.v[7];
    if (player && p.playerActivity > 0) {
      const w = this.omega(7);
      const a = p.playerActivity * 0.04 * Math.sin(w * t);
      this.kick(player, [0.5 + 0.3 * Math.cos(0.004 * t), 0.5 + 0.3 * Math.sin(0.004 * t), 0.5], s, a);
      this.kick(player, [0.5 - 0.3 * Math.cos(0.004 * t), 0.5 - 0.3 * Math.sin(0.004 * t), 0.5], s, -a);
    }

    const director = this.v[9];
    if (director && p.directorIntent > 0) {
      const phrase = 0.5 + 0.5 * Math.sin(0.002 * t);
      this.kick(director, [0.5, 0.5, 0.5], s * 1.4, p.directorIntent * 0.05 * phrase * Math.sin(this.omega(9) * t));
    }

    const mind = this.v[8];
    if (mind) {
      const w = this.omega(8);
      if (p.pain > 0) {
        if (t >= this.painUntil) {
          this.painPos = [0.15 + 0.7 * Math.random(), 0.15 + 0.7 * Math.random(), 0.15 + 0.7 * Math.random()];
          this.painUntil = t + 25 + Math.random() * 40;
        }
        this.kick(mind, this.painPos, s * 0.7, p.pain * 0.3 * Math.sin(w * 2.4 * t));
      }
      if (p.delight > 0) this.kick(mind, [0.5, 0.5, 0.5], s * 1.6, p.delight * 0.08 * Math.sin(w * t));
      if (p.interest > 0) this.kick(mind, [0.7, 0.35, 0.5], s * 0.9, p.interest * 0.08 * Math.sin(w * 0.5 * t));
      if (p.curiosity > 0) {
        const pos: Vec3 = [0.5 + 0.35 * Math.sin(0.011 * t), 0.5 + 0.35 * Math.sin(0.017 * t + 1), 0.5 + 0.3 * Math.sin(0.007 * t + 2)];
        this.kick(mind, pos, s, p.curiosity * 0.06 * Math.sin(w * 1.5 * t));
      }
      if (p.ecstasy > 0) this.standing(mind, g * p.ecstasy * 0.03 * Math.sin(w * t) * (0.6 + 0.4 * Math.sin(0.003 * t)));
    }

    if (p.dust > 0) {
      const sprinkles = Math.max(1, Math.round(p.dust * 6));
      for (let l = 0; l < NUM_LAYERS; l++) {
        const f = this.v[l];
        if (!f) continue;
        const sPrev = l === 0 ? 1 : this.stability[l - 1] ?? 1;
        const gain = g * p.dust * 0.15 * (1 + 2 * p.stabilization * (1 - sPrev)) * (1 + psy);
        for (let k = 0; k < sprinkles; k++) {
          const i = (Math.random() * this.size) | 0;
          f[i] = (f[i] ?? 0) + gain * gauss();
        }
      }
    }
  }

  step(p: Params): void {
    this.applyDrives(p);

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
    const nAxes = (hasX ? 1 : 0) + (hasY ? 1 : 0) + (hasZ ? 1 : 0);

    const psy = p.psychedelic;
    // Up/down couplings are made energy-consistent (geometric layer masses) by bounding their ratio;
    // a fully one-way chain would be an active, runaway-prone system.
    const upRaw = 0.02 * p.couplingUp ** 2 * (1 + 3 * psy);
    const downRaw = 0.02 * p.couplingDown ** 2 * (1 + 3 * psy);
    const hi = Math.max(upRaw, downRaw);
    const kUp = Math.min(MAX_COUPLING, Math.max(upRaw, hi * 0.5));
    const kDown = Math.min(MAX_COUPLING, Math.max(downRaw, hi * 0.5));
    const kCtx = 0.03 * psy;
    const stab = p.stabilization * (1 - 0.7 * psy);
    const ctx = this.ctx;

    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      const v = this.v[l];
      if (!u || !v) continue;
      const below = l > 0 ? this.u[l - 1] : undefined;
      const above = l < NUM_LAYERS - 1 ? this.u[l + 1] : undefined;
      const sPrev = l === 0 ? 1 : this.stability[l - 1] ?? 1;
      const cf = 0.3 + 0.3 * (l / (NUM_LAYERS - 1));
      const c2 = (cf * cf) / nAxes;
      const gamma = p.damping + stab * 0.03 * sPrev;
      const ks = stab * 0.004 * sPrev;

      for (let z = z0; z < z1; z++) {
        for (let y = y0; y < y1; y++) {
          let i = x0 + y * sy + z * sz;
          for (let x = x0; x < x1; x++, i++) {
            const c = u[i] ?? 0;
            let lap = 0;
            if (hasX) lap += (u[i - sx] ?? 0) + (u[i + sx] ?? 0) - 2 * c;
            if (hasY) lap += (u[i - sy] ?? 0) + (u[i + sy] ?? 0) - 2 * c;
            if (hasZ) lap += (u[i - sz] ?? 0) + (u[i + sz] ?? 0) - 2 * c;
            let a = c2 * lap - ks * c - gamma * (v[i] ?? 0);
            if (below) a += kUp * ((below[i] ?? 0) - c);
            if (above) a += kDown * ((above[i] ?? 0) - c);
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

  // Recomputes the slow observables: rms, stability chain, vitality, Maslow fulfilment, context alignment.
  observe(p: Params): void {
    this.updateContext(p.context);
    const n = this.size;
    let ctxNorm = 0;
    for (let i = 0; i < n; i++) ctxNorm += (this.ctx[i] ?? 0) ** 2;
    ctxNorm = Math.sqrt(ctxNorm) + 1e-9;

    let align = 0;
    for (let l = 0; l < NUM_LAYERS; l++) {
      const u = this.u[l];
      if (!u) continue;
      let s2 = 0;
      let dot = 0;
      for (let i = 0; i < n; i++) {
        const x = u[i] ?? 0;
        s2 += x * x;
        dot += x * (this.ctx[i] ?? 0);
      }
      const rms = Math.sqrt(s2 / n);
      this.rms[l] = (this.rms[l] ?? 0) * 0.8 + rms * 0.2;
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

    let avail = 1;
    MASLOW.forEach((level, m) => {
      const first = level.layers[0] ?? 0;
      const sBelow = first === 0 ? 1 : this.stability[first - 1] ?? 1;
      let sum = 0;
      for (const l of level.layers) sum += this.vitality[l] ?? 0;
      const f = clamp((sum / level.layers.length) * sBelow, 0, 1);
      this.availability[m] = avail;
      this.fulfilment[m] = (this.fulfilment[m] ?? 0) * 0.85 + f * avail * 0.15;
      avail = clamp(avail * (0.35 + 0.65 * Math.min(1, f * 1.5)), 0, 1);
    });
  }
}
