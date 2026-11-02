// A reusable auto-wah: an envelope follower (rectify + smooth, the classic no-worklet WebAudio trick) drives the centre
// frequency of a resonant bandpass filter, audio-rate, so every note gets its own "cry" from how hard it was struck instead
// of a scripted sweep. This is what gives a clavinet its funk bite and a wah pedal its touch-sensitive feel.

export interface Wah {
  readonly input: AudioNode;
  readonly output: AudioNode;
}

let rectCurve: Float32Array | null = null;
function absCurve(): Float32Array {
  if (rectCurve) return rectCurve;
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.abs((i / (n - 1)) * 2 - 1);
  rectCurve = c;
  return c;
}

export interface WahOpts {
  base?: number; // resting centre frequency, Hz
  range?: number; // how far the envelope can push the centre up, Hz
  q?: number; // resonance (higher = narrower, more vocal "cry")
  speed?: number; // envelope follower cutoff, Hz (higher = snaps faster to transients)
}

/** `end` is the absolute AudioContext time to stop the envelope follower's source; always pass one, every note needs it. */
export function makeWah(ctx: BaseAudioContext, end: number, opts: WahOpts = {}): Wah {
  const input = ctx.createGain();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = opts.q ?? 5;
  bp.frequency.value = opts.base ?? 500;
  const rect = ctx.createWaveShaper();
  rect.curve = absCurve() as Float32Array<ArrayBuffer>;
  const smooth = ctx.createBiquadFilter();
  smooth.type = "lowpass";
  smooth.frequency.value = opts.speed ?? 9;
  const envGain = ctx.createGain();
  envGain.gain.value = opts.range ?? 1800;
  const envOffset = ctx.createConstantSource();
  envOffset.offset.value = opts.base ?? 500;
  envOffset.start();
  envOffset.stop(end);
  input.connect(bp);
  input.connect(rect);
  rect.connect(smooth);
  smooth.connect(envGain);
  envGain.connect(bp.frequency);
  envOffset.connect(bp.frequency);
  return { input, output: bp };
}
