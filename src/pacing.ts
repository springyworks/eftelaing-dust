// Device check and speed test. The ten tanks are a physics simulation plus a live synthesizer, which asks a lot of a phone.
// This module only holds the pure parts (device facts, the decision and the wording); the measuring is done by main.ts on the
// running app.

export interface DeviceInfo {
  cores: number;
  memoryGb: number | null;
  mobile: boolean;
  webgpu: boolean;
}

export function deviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (typeof matchMedia === "function" && matchMedia("(pointer: coarse) and (max-width: 900px)").matches);
  return { cores: nav.hardwareConcurrency || 1, memoryGb: nav.deviceMemory ?? null, mobile, webgpu: Boolean((navigator as { gpu?: unknown }).gpu) };
}

export interface PaceResult {
  gpu: number | null; // steps per second measured with the GPU solver, null when there is none
  cpu: number;
  need: number; // steps per second the chosen speed asks for at 60 frames per second
  chosen: "gpu" | "cpu";
  best: number;
  ratio: number;
  speed: number; // the speed to run at (lowered when the device cannot keep up)
  verdict: "plenty" | "ok" | "tight" | "slow";
}

/** The GPU wins unless it is clearly slower than the CPU: it leaves the CPU free for the synthesizer and saves battery. */
export function decide(gpu: number | null, cpu: number, speed: number): PaceResult {
  const chosen = gpu !== null && gpu >= 0.9 * cpu ? "gpu" : "cpu";
  const best = chosen === "gpu" && gpu !== null ? gpu : cpu;
  const need = speed * 60;
  const ratio = best / Math.max(1, need);
  const verdict = ratio >= 2 ? "plenty" : ratio >= 1.15 ? "ok" : ratio >= 0.85 ? "tight" : "slow";
  const fit = Math.max(1, Math.floor((best / 60) * 0.85));
  return { gpu, cpu, need, chosen, best, ratio, speed: ratio >= 1 ? speed : Math.min(speed, fit), verdict };
}

export function describe(r: PaceResult, d: DeviceInfo, gpuReason: string): string[] {
  const lines: string[] = [];
  const rate = (v: number): string => `${v.toFixed(0)} steps/s`;
  lines.push(
    `Speed test (full app under load): ${r.gpu !== null ? `WebGPU ${rate(r.gpu)}, ` : ""}CPU ${rate(r.cpu)}; at speed ${(r.need / 60).toFixed(0)} the instrument needs ${rate(r.need)}. ` +
      `Running on the ${r.chosen === "gpu" ? "GPU" : "CPU"}: ${{ plenty: "plenty of headroom.", ok: "enough headroom.", tight: "tight, expect some stutter.", slow: "too slow for real time." }[r.verdict]}`,
  );
  if (r.gpu === null) lines.push(`No WebGPU here (${gpuReason}), so the backup CPU solver does the work. It is exact, just a heavier load on the processor.`);
  else if (r.chosen === "cpu") lines.push("The graphics card was slower than the processor on this device, so the CPU solver is used.");
  if (r.speed < r.need / 60) lines.push(`I lowered the speed slider to ${r.speed} so the picture and the sound keep up. Tank dimension 1D or 2D is lighter still.`);
  if (d.mobile || r.chosen === "cpu") {
    lines.push(
      `Heads up${d.mobile ? " for phones" : ""}: this app simulates ten wave tanks and runs a live synthesizer, which needs real processor power and battery${d.mobile ? " and can make the phone warm" : ""}. ` +
        `Plug in, use headphones, and lower Speed or the tank dimension if it stutters. This device: ${d.cores} core${d.cores === 1 ? "" : "s"}${d.memoryGb ? `, ${d.memoryGb} GB` : ""}. The solver uses one core (the page's main thread).`,
    );
  }
  return lines;
}
