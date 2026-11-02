// Health watch over the audio chain: a Tap is an AnalyserNode listening at one stage (a bus may feed it from several
// nodes; the analyser sums exactly like the bus does). Every frame it reads the true peak, so clipping is detected where
// it happens (per voice bus, the mix, the output), not guessed. A stage that is being *sent* notes but produces silence
// for seconds is flagged dead - the other failure the ear notices but a VU bar hides. countSources() counts the live
// scheduled sources on the context: the honest "is something clogging up?" number.

export interface StageHealth {
  name: string;
  peak: number; // instantaneous peak of the last frame, linear (1 = full scale)
  hold: number; // slowly falling peak for display
  clips: number; // how often this stage went over its ceiling
  clipAge: number | null; // seconds since the last clip, null = never
  silentFor: number; // seconds without any signal at all
  expected: boolean; // the app believes this stage should be sounding right now
  dead: boolean; // expected for a while, yet silent: a broken branch
}

export class Tap {
  private readonly an: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  peak = 0;
  hold = 0;
  clips = 0;
  private lastClip = -Infinity;
  private silentFor = 0;
  private expectedFor = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly name: string,
    private readonly over = 1,
  ) {
    this.an = ctx.createAnalyser();
    this.an.fftSize = 512;
    this.an.smoothingTimeConstant = 0;
    this.buf = new Float32Array(this.an.fftSize);
  }

  /** Listen to one more node; several nodes may feed one tap. */
  add(node: AudioNode): void {
    node.connect(this.an);
  }

  measure(dt: number): void {
    this.an.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (const s of this.buf) {
      const a = Math.abs(s);
      if (a > p) p = a;
    }
    this.peak = p;
    this.hold = Math.max(p, this.hold - dt * 0.8);
    if (p >= this.over) {
      this.clips++;
      this.lastClip = this.ctx.currentTime;
    }
    this.silentFor = p > 1e-4 ? 0 : this.silentFor + dt;
  }

  health(expected: boolean, dt: number): StageHealth {
    this.expectedFor = expected ? this.expectedFor + dt : 0;
    return {
      name: this.name,
      peak: this.peak,
      hold: this.hold,
      clips: this.clips,
      clipAge: this.lastClip === -Infinity ? null : this.ctx.currentTime - this.lastClip,
      silentFor: this.silentFor,
      expected,
      dead: this.expectedFor > 6 && this.silentFor > 6,
    };
  }
}

export interface HealthReport {
  level: number; // output peak 0..1, the lamp's blue filling
  duckDb: number; // how hard the ALC and limiter are pulling down (negative dB)
  clip: string | null; // the stage that clipped within the last 3 s, if any
  dead: string[]; // stages that should sound but stay silent
  sources: { live: number; made: number };
  stages: StageHealth[];
}

/** Count every scheduled source the app makes on this context; `live` falls again when a source really ends. */
export function countSources(ctx: AudioContext, out: { live: number; made: number }): void {
  const wrap = (k: "createOscillator" | "createBufferSource" | "createConstantSource"): void => {
    const orig = ctx[k].bind(ctx) as () => AudioScheduledSourceNode;
    (ctx as unknown as Record<string, () => AudioScheduledSourceNode>)[k] = () => {
      const n = orig();
      out.live++;
      out.made++;
      n.addEventListener("ended", () => {
        out.live--;
      });
      return n;
    };
  };
  wrap("createOscillator");
  wrap("createBufferSource");
  wrap("createConstantSource");
}
