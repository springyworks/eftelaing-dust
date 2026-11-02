// WebGPU solver for the ten wave tanks. The GPU owns the fields u and v; the CPU keeps a mirror that is read back one or two
// frames late (the sand, the observables, the band and the renderers read the mirror). Everything that the CPU used to write
// into the fields (finger scratches, fires, drives, dust) travels as small "ops" that a compute kernel adds before the steps.
// The step kernel is the same maths as Simulation.step: v += a, u += v, clamp at ±2, Dirichlet walls.

export const MAX_OPS = 4096;
const MAX_STEPS = 16; // steps per frame that keep their own op slot (the Speed slider tops out at 8)
const SLOT = 11; // layer boundaries (10 layers) per step slot
const WG = 64;

/** One additive write into the field of a layer: a gaussian bump, the standing mode, or a single cell. */
export interface GpuOp {
  step: number; // applied just before this step of the frame (steps = after the last one)
  layer: number;
  isV: boolean;
  kind: 0 | 1 | 2; // 0 gaussian bump, 1 standing sine mode, 2 single cell
  amp: number;
  cx: number;
  cy: number;
  cz: number;
  inv: number; // 1 / (2 sigma^2) for a bump; the flat cell index for kind 2
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface GpuFrame {
  ops: GpuOp[];
  steps: number;
  /** Per layer: c2, gamma, ks, kU, kD, useCs, useCplU, useCplD. */
  layer: Float32Array;
  kCtx: number;
  cscale: Float32Array[];
  cpl: Float32Array[];
  ctx: Float32Array;
}

const STEP_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> ui: array<f32>;
@group(0) @binding(1) var<storage, read_write> uo: array<f32>;
@group(0) @binding(2) var<storage, read_write> vv: array<f32>;
@group(0) @binding(3) var<storage, read> cscale: array<f32>;
@group(0) @binding(4) var<storage, read> cpl: array<f32>;
@group(0) @binding(5) var<storage, read> ctx: array<f32>;
@group(0) @binding(6) var<storage, read> lp: array<vec4<f32>>;

const MAXL: f32 = 0.12;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let h0 = lp[0];
  let h1 = lp[1];
  let nx = u32(h0.x);
  let ny = u32(h0.y);
  let nz = u32(h0.z);
  let size = u32(h0.w);
  let plane = nx * ny;
  let layers = u32(h1.x);
  let idx = gid.x;
  if (idx >= layers * size) { return; }
  let l = idx / size;
  let i = idx - l * size;
  let x = i % nx;
  let y = (i / nx) % ny;
  let z = i / plane;
  var edge = x == 0u || x == nx - 1u;
  if (ny > 1u && (y == 0u || y == ny - 1u)) { edge = true; }
  if (nz > 1u && (z == 0u || z == nz - 1u)) { edge = true; }
  if (edge) {
    uo[idx] = 0.0;
    vv[idx] = 0.0;
    return;
  }
  let c = ui[idx];
  var lap = 0.0;
  lap += ui[idx - 1u] + ui[idx + 1u] - 2.0 * c;
  if (ny > 1u) { lap += ui[idx - nx] + ui[idx + nx] - 2.0 * c; }
  if (nz > 1u) { lap += ui[idx - plane] + ui[idx + plane] - 2.0 * c; }
  let p0 = lp[2u + 2u * l];
  let p1 = lp[3u + 2u * l];
  let pi = x + y * nx;
  var cs = 1.0;
  if (p1.y > 0.5) { cs = cscale[l * plane + pi]; }
  let v0 = vv[idx];
  var a = p0.x * cs * lap - p0.z * c - p0.y * v0;
  if (l > 0u) {
    var k = p0.w;
    if (p1.z > 0.5) { k = min(MAXL, k * cpl[(l - 1u) * plane + pi]); }
    a += k * (ui[idx - size] - c);
  }
  if (l + 1u < layers) {
    var k = p1.x;
    if (p1.w > 0.5) { k = min(MAXL, k * cpl[l * plane + pi]); }
    a += k * (ui[idx + size] - c);
  }
  if (h1.y > 0.0) { a += h1.y * (ctx[i] - c); }
  var nv = v0 + a;
  var nu = c + nv;
  if (nu > 2.0) { nu = 2.0; nv = 0.0; }
  else if (nu < -2.0) { nu = -2.0; nv = 0.0; }
  uo[idx] = nu;
  vv[idx] = nv;
}
`;

const OPS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> uu: array<f32>;
@group(0) @binding(1) var<storage, read_write> vv: array<f32>;
@group(0) @binding(2) var<storage, read> ops: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> inf: array<u32>;
@group(0) @binding(4) var<uniform> sd: vec4<u32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = inf[0];
  let ny = inf[1];
  let nz = inf[2];
  let size = inf[3];
  let layers = inf[4];
  let idx = gid.x;
  if (idx >= layers * size) { return; }
  let l = idx / size;
  let i = idx - l * size;
  let plane = nx * ny;
  let x = i % nx;
  let y = (i / nx) % ny;
  let z = i / plane;
  let fx = f32(x);
  let fy = f32(y);
  let fz = f32(z);
  var au = 0.0;
  var av = 0.0;
  for (var k = inf[5u + sd.x * 11u + l]; k < inf[6u + sd.x * 11u + l]; k++) {
    let o0 = ops[4u * k];
    let o1 = ops[4u * k + 1u];
    let o2 = ops[4u * k + 2u];
    let o3 = ops[4u * k + 3u];
    let kind = u32(o0.z);
    var val = 0.0;
    if (kind == 0u) {
      if (fx >= o2.x && fx <= o2.y && fy >= o2.z && fy <= o2.w && fz >= o3.x && fz <= o3.y) {
        let d2 = (fx - o1.x) * (fx - o1.x) + (fy - o1.y) * (fy - o1.y) + (fz - o1.z) * (fz - o1.z);
        val = o0.w * exp(-d2 * o1.w);
      }
    } else if (kind == 1u) {
      var s = sin(3.14159265 * fx / f32(nx - 1u));
      if (ny > 1u) { s = s * sin(3.14159265 * fy / f32(ny - 1u)); }
      if (nz > 1u) { s = s * sin(3.14159265 * fz / f32(nz - 1u)); }
      val = o0.w * s;
    } else if (i == u32(o1.w)) {
      val = o0.w;
    }
    if (o0.y > 0.5) { av += val; } else { au += val; }
  }
  uu[idx] += au;
  vv[idx] += av;
}
`;

export class GpuSolver {
  lost = false;
  error = "";
  adapterInfo = "";
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private size = 0;
  private plane = 0;
  private gen = 0;
  private parity = 0; // which of the two u buffers holds the current field
  private u: [GPUBuffer, GPUBuffer] | null = null;
  private v: GPUBuffer | null = null;
  private cscale: GPUBuffer | null = null;
  private cpl: GPUBuffer | null = null;
  private ctx: GPUBuffer | null = null;
  private lp: GPUBuffer | null = null;
  private stageU: GPUBuffer | null = null;
  private stageV: GPUBuffer | null = null;
  private stepGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private opsGroups: [GPUBuffer, GPUBuffer] | null = null;
  private reading = false;
  private submitted = 0;
  /** Steps the graphics card has really finished (a readback of them came back); the speed test counts these, not the queued ones. */
  completedSteps = 0;
  private csPack = new Float32Array(0);
  private cplPack = new Float32Array(0);
  private lpPack = new Float32Array(0);
  private readonly opsData = new Float32Array(MAX_OPS * 16);
  private readonly meta = new Uint32Array(5 + (MAX_STEPS + 1) * SLOT);
  private readonly slotBufs: GPUBuffer[] = [];
  private readonly opsGroupCache = new Map<number, GPUBindGroup>();
  private readonly opsBuf: GPUBuffer;
  private readonly metaBuf: GPUBuffer;
  private readonly stepPipe: GPUComputePipeline;
  private readonly opsPipe: GPUComputePipeline;
  /** Called when a fresh readback has been copied into the CPU mirror. */
  onMirror: (() => void) | null = null;

  private constructor(readonly device: GPUDevice) {
    this.opsBuf = device.createBuffer({ size: MAX_OPS * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.metaBuf = device.createBuffer({ size: this.meta.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    for (let k = 0; k <= MAX_STEPS; k++) {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([k, 0, 0, 0]));
      this.slotBufs.push(b);
    }
    this.stepPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: STEP_WGSL }), entryPoint: "main" } });
    this.opsPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: OPS_WGSL }), entryPoint: "main" } });
    void device.lost.then((info) => {
      this.lost = true;
      this.error = `device lost: ${info.message}`;
    });
    device.addEventListener("uncapturederror", (e) => {
      this.lost = true;
      this.error = (e as GPUUncapturedErrorEvent).error.message;
    });
  }

  /** Null when there is no WebGPU or no adapter. */
  static async create(): Promise<GpuSolver | null> {
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const s = new GpuSolver(device);
      const info = adapter.info;
      s.adapterInfo = [info?.vendor, info?.architecture].filter(Boolean).join(" ") || "adapter";
      return s;
    } catch {
      return null;
    }
  }

  /** (Re)allocates the buffers for a grid. The fields start at zero until upload(). */
  configure(nx: number, ny: number, nz: number): void {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.size = nx * ny * nz;
    this.plane = nx * ny;
    this.gen++;
    this.parity = 0;
    this.reading = false;
    for (const b of [this.u?.[0], this.u?.[1], this.v, this.cscale, this.cpl, this.ctx, this.lp, this.stageU, this.stageV]) b?.destroy();
    const d = this.device;
    const L = 10;
    const field = L * this.size * 4;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.u = [d.createBuffer({ size: field, usage: storage }), d.createBuffer({ size: field, usage: storage })];
    this.v = d.createBuffer({ size: field, usage: storage });
    this.cscale = d.createBuffer({ size: L * this.plane * 4, usage: storage });
    this.cpl = d.createBuffer({ size: (L - 1) * this.plane * 4, usage: storage });
    this.ctx = d.createBuffer({ size: this.size * 4, usage: storage });
    this.lp = d.createBuffer({ size: (2 + 2 * L) * 16, usage: storage });
    this.stageU = d.createBuffer({ size: field, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.stageV = d.createBuffer({ size: field, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.csPack = new Float32Array(L * this.plane);
    this.cplPack = new Float32Array((L - 1) * this.plane);
    this.lpPack = new Float32Array((2 + 2 * L) * 4);
    this.meta.set([nx, ny, nz, this.size, L]);
    const sg = (a: GPUBuffer, b: GPUBuffer): GPUBindGroup =>
      d.createBindGroup({
        layout: this.stepPipe.getBindGroupLayout(0),
        entries: [a, b, this.v as GPUBuffer, this.cscale as GPUBuffer, this.cpl as GPUBuffer, this.ctx as GPUBuffer, this.lp as GPUBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    const [u0, u1] = this.u;
    this.stepGroups = [sg(u0, u1), sg(u1, u0)];
    this.opsGroupCache.clear();
    this.opsGroups = [u0, u1];
  }

  /** Replaces the GPU fields with the CPU ones (after a reset, a dimension change or switching to the GPU). */
  upload(u: Float32Array[], v: Float32Array[]): void {
    if (!this.u || !this.v) return;
    this.gen++; // a readback in flight holds the old fields
    this.parity = 0;
    const pu = new Float32Array(10 * this.size);
    const pv = new Float32Array(10 * this.size);
    for (let l = 0; l < 10; l++) {
      pu.set(u[l] ?? new Float32Array(this.size), l * this.size);
      pv.set(v[l] ?? new Float32Array(this.size), l * this.size);
    }
    this.device.queue.writeBuffer(this.u[0], 0, pu);
    this.device.queue.writeBuffer(this.u[1], 0, pu);
    this.device.queue.writeBuffer(this.v, 0, pv);
  }

  /** Applies the ops, runs the steps and starts a readback. Call once per animation frame. */
  run(f: GpuFrame): void {
    if (this.lost || !this.u || !this.v || !this.stepGroups || !this.opsGroups) return;
    const d = this.device;
    const { size, plane } = this;
    const hasWork = f.steps > 0 || f.ops.length > 0;

    if (hasWork) {
      // constants of this frame: layer coefficients, sand and context
      const lp = this.lpPack;
      lp.set([this.nx, this.ny, this.nz, size, 10, f.kCtx, 0, 0]);
      lp.set(f.layer, 8);
      d.queue.writeBuffer(this.lp as GPUBuffer, 0, lp);
      for (let l = 0; l < 10; l++) this.csPack.set(f.cscale[l] ?? new Float32Array(plane).fill(1), l * plane);
      for (let l = 0; l < 9; l++) this.cplPack.set(f.cpl[l] ?? new Float32Array(plane).fill(1), l * plane);
      d.queue.writeBuffer(this.cscale as GPUBuffer, 0, this.csPack);
      d.queue.writeBuffer(this.cpl as GPUBuffer, 0, this.cplPack);
      if (f.kCtx > 0) d.queue.writeBuffer(this.ctx as GPUBuffer, 0, f.ctx);
    }

    const enc = d.createCommandEncoder();
    const groups = Math.ceil((10 * size) / WG);

    // Ops are binned per (step slot, layer) so that each lands just before its own step, as on the CPU.
    const hasOps = new Uint8Array(MAX_STEPS + 1);
    if (f.ops.length > 0) {
      const slotOf = (o: GpuOp): number => Math.min(MAX_STEPS, o.step);
      const sorted = (f.ops.length > MAX_OPS ? f.ops.slice(0, MAX_OPS) : f.ops.slice()).sort((a, b) => slotOf(a) - slotOf(b) || a.layer - b.layer);
      const data = this.opsData;
      let k = 0;
      for (let s = 0; s <= MAX_STEPS; s++) {
        for (let l = 0; l < 10; l++) {
          this.meta[5 + s * SLOT + l] = k;
          for (; k < sorted.length; k++) {
            const o = sorted[k] as GpuOp;
            if (slotOf(o) !== s || o.layer !== l) break;
            const j = k * 16;
            data[j] = o.layer;
            data[j + 1] = o.isV ? 1 : 0;
            data[j + 2] = o.kind;
            data[j + 3] = o.amp;
            data[j + 4] = o.cx;
            data[j + 5] = o.cy;
            data[j + 6] = o.cz;
            data[j + 7] = o.inv;
            data[j + 8] = o.x0;
            data[j + 9] = o.x1;
            data[j + 10] = o.y0;
            data[j + 11] = o.y1;
            data[j + 12] = o.z0;
            data[j + 13] = o.z1;
            hasOps[s] = 1;
          }
        }
        this.meta[5 + s * SLOT + 10] = k;
      }
      d.queue.writeBuffer(this.opsBuf, 0, data, 0, k * 16);
      d.queue.writeBuffer(this.metaBuf, 0, this.meta);
    }

    if (hasWork) {
      const pass = enc.beginComputePass();
      for (let s = 0; s <= f.steps; s++) {
        if (s <= MAX_STEPS && hasOps[s]) {
          pass.setPipeline(this.opsPipe);
          pass.setBindGroup(0, this.opsGroup(s));
          pass.dispatchWorkgroups(groups);
        }
        if (s < f.steps) {
          pass.setPipeline(this.stepPipe);
          pass.setBindGroup(0, this.stepGroups[this.parity] as GPUBindGroup);
          pass.dispatchWorkgroups(groups);
          this.parity ^= 1;
        }
      }
      pass.end();
    }

    const su = this.stageU;
    const sv = this.stageV;
    const read = hasWork && !this.reading && su !== null && sv !== null;
    if (read) {
      const bytes = 10 * size * 4;
      enc.copyBufferToBuffer(this.u[this.parity] as GPUBuffer, 0, su, 0, bytes);
      enc.copyBufferToBuffer(this.v, 0, sv, 0, bytes);
    }
    d.queue.submit([enc.finish()]);
    this.submitted += f.steps;
    if (read) this.startRead();
  }

  private opsGroup(slot: number): GPUBindGroup {
    const key = this.parity * 100 + slot;
    let g = this.opsGroupCache.get(key);
    if (!g) {
      const buffers = [this.opsGroups?.[this.parity], this.v, this.opsBuf, this.metaBuf, this.slotBufs[slot]] as GPUBuffer[];
      g = this.device.createBindGroup({ layout: this.opsPipe.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.opsGroupCache.set(key, g);
    }
    return g;
  }

  private mirrorTo: { u: Float32Array[]; v: Float32Array[] } | null = null;

  /** Where the finished readbacks go (the CPU mirror arrays; they are replaced when the grid changes, so pass them each frame). */
  setMirror(u: Float32Array[], v: Float32Array[]): void {
    this.mirrorTo = { u, v };
  }

  private startRead(): void {
    const su = this.stageU;
    const sv = this.stageV;
    if (!su || !sv) return;
    this.reading = true;
    const gen = this.gen;
    const mark = this.submitted;
    void Promise.all([su.mapAsync(GPUMapMode.READ), sv.mapAsync(GPUMapMode.READ)])
      .then(() => {
        const a = new Float32Array(su.getMappedRange());
        const b = new Float32Array(sv.getMappedRange());
        const m = this.mirrorTo;
        if (m && gen === this.gen) {
          for (let l = 0; l < 10; l++) {
            m.u[l]?.set(a.subarray(l * this.size, (l + 1) * this.size));
            m.v[l]?.set(b.subarray(l * this.size, (l + 1) * this.size));
          }
        }
        su.unmap();
        sv.unmap();
        this.completedSteps = Math.max(this.completedSteps, mark);
        if (su === this.stageU) this.reading = false;
        if (gen === this.gen) this.onMirror?.();
      })
      .catch(() => {
        if (su === this.stageU) this.reading = false;
      });
  }
}
