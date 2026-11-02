// Monte Carlo slider exerciser: moves the sliders by itself, asks "No / Maybe / Yes?" in a popup and learns the taste.

import type { Params } from "./model";
import { TasteModel, type Rating } from "./taste";
import { SLIDERS, helpButton, type NumKey, type SliderSpec } from "./ui";
import { feedbackStatus, onFeedbackChange, queueNote } from "./feedback";

const RATING_NAME = new Map<number, string>([
  [-0.5, "hellish"],
  [0, "no"],
  [0.25, "boring"],
  [0.5, "maybe"],
  [1, "yes"],
  [1.5, "heavenly"],
]);

const STORAGE_KEY = "eftelaing-dust.taste.v1";
const NOT_EXERCISED: readonly NumKey[] = ["speed", "volume", "alcCeiling", "rawLevel", "bandLevel"]; // the human always owns these

type Mode = "off" | "glide" | "listen" | "ask";

interface Setting {
  glide: number; // seconds the sliders take to move
  listen: number; // seconds to experience the new setting before asking
  explore: number;
  radius: number;
  moves: number;
  forget: number; // seconds until half of your own slider move is forgotten again
}

// Optional "what is off?" hints. Each one nudges the sliders it names on the next proposal (or right away when idle).
// "@loud" / "@quiet" are resolved to the level slider of the voice that currently dominates or is buried in the mix.
const HINTS = [
  { id: "flat", group: "Dynamics", label: "Too flat", tip: "Dynamics: nothing moves enough", push: [["instrumentDrive", 1], ["spikeSens", 1], ["fmDepth", 1]] },
  { id: "wild", group: "Dynamics", label: "Too wild", tip: "Dynamics: too loud, too violent", push: [["instrumentDrive", -1], ["damping", 1], ["spikeSens", -1]] },
  { id: "dull", group: "Voices", label: "Dull voices", tip: "Voices: lifeless, thin", push: [["fmDepth", 1], ["width", 1], ["reverb", 1]] },
  { id: "harsh", group: "Voices", label: "Harsh voices", tip: "Voices: sharp, buzzy", push: [["fmDepth", -1], ["reverb", 1], ["damping", 1]] },
  { id: "loud", group: "Voices", label: "A voice dominates", tip: "Mix: one voice drowns the others, the loudest one is pulled down", push: [["@loud", -1]] },
  { id: "lost", group: "Voices", label: "A voice is lost", tip: "Mix: one voice is buried, the quietest one is pulled up", push: [["@quiet", 1]] },
  { id: "thinbass", group: "Voices", label: "Bass too thin", tip: "Urban: no weight in the low end", push: [["bandBass", 1], ["bandDrums", 1]] },
  { id: "boomy", group: "Voices", label: "Bass too boomy", tip: "Urban: muddy low end", push: [["bandBass", -1], ["reverb", -1]] },
  { id: "washy", group: "Space", label: "Too washy", tip: "Too much reverb and sustain, no definition", push: [["reverb", -1], ["bandChoir", -1]] },
  { id: "dry", group: "Space", label: "Too dry / cold", tip: "Too close and sterile, needs air and a room", push: [["reverb", 1], ["width", 1]] },
  { id: "stiff", group: "Rhythm", label: "Stiff rhythm", tip: "Rhythm: too square", push: [["swing", 1], ["spikeSens", 1]] },
  { id: "messy", group: "Rhythm", label: "Messy rhythm", tip: "Rhythm: no pulse", push: [["swing", -1], ["jazz", 1], ["spikeSens", -1]] },
  { id: "mechanical", group: "Rhythm", label: "Too mechanical", tip: "Sounds like a machine: more human timing, dynamics and loose feel", push: [["bandHuman", 1], ["swing", 1], ["dust", 1]] },
  { id: "noswing", group: "Rhythm", label: "Not swinging", tip: "It does not swing: triplet feel, ride, ghost notes. Also teaches the brain: it practises swing and leans to the swinging styles", push: [["swing", 1], ["bandGroove", 1], ["bandHuman", 1]] },
  { id: "sloppy", group: "Rhythm", label: "Too sloppy", tip: "Falls apart: tighter timing and even dynamics", push: [["bandHuman", -1], ["dust", -1]] },
  { id: "groove", group: "Rhythm", label: "No groove", tip: "Urban: needs a pocket: ride, bass and swing locked in", push: [["bandDrums", 1], ["bandBass", 1], ["swing", 1]] },
  { id: "busy", group: "Rhythm", label: "Too busy", tip: "Too many notes: give the music room to breathe", push: [["bandDensity", -1], ["bandChoir", -1]] },
  { id: "sparse", group: "Rhythm", label: "Too sparse", tip: "Not enough going on", push: [["bandDensity", 1], ["bandKeys", 1]] },
  { id: "slow", group: "Tempo", label: "Drags", tip: "Too slow", push: [["tempo", 1]] },
  { id: "rushed", group: "Tempo", label: "Rushed", tip: "Too fast, no time to breathe", push: [["tempo", -1]] },
  { id: "samey", group: "Form", label: "Too little variation", tip: "The same thing again and again: themes should develop, instruments and layers should change", push: [["bandVariation", 1], ["bandSwitch", 1], ["bandBrain", 1]] },
  { id: "unstable", group: "Form", label: "No hook / too unstable", tip: "Keeps changing, nothing to hold on to: a theme should recur", push: [["bandVariation", -1], ["bandSwitch", -1]] },
  { id: "noriffs", group: "Form", label: "No riffs / licks", tip: "The lead plays no fast phrases or riffs: want runs, licks and repeated riffs. Also teaches the brain more vocabulary", push: [["bandRiffs", 1], ["bandDensity", 1]] },
  { id: "oldband", group: "Form", label: "Same old tune", tip: "An old band playing the same tune: the brain picks another style and chord progression at the next change", push: [["bandVariation", 1], ["bandRiffs", 1]] },
  { id: "wantbebop", group: "Style", label: "Want bebop", tip: "Teaches the brain to prefer fast bebop with runs and enclosures", push: [] },
  { id: "wantswing", group: "Style", label: "Want swing", tip: "Teaches the brain to prefer relaxed swing with walking bass and ride", push: [] },
  { id: "wantfusion", group: "Style", label: "Want fusion", tip: "Teaches the brain to prefer fusion: 16th grooves, bursts, m11 colours", push: [] },
  { id: "wantfunk", group: "Style", label: "Want funk", tip: "Teaches the brain to prefer funk: the one, ghost notes and riffs", push: [] },
  { id: "wantbossa", group: "Style", label: "Want bossa", tip: "Teaches the brain to prefer soft bossa", push: [] },
  { id: "jarring", group: "Form", label: "Jarring instrument change", tip: "An instrument swap does not feel musical: swap rarely", push: [["bandSwitch", -1]] },
  { id: "melody", group: "Form", label: "Melody lost", tip: "Theory: the tune is not carried, the lead should lead", push: [["bandLead", 1], ["bandChoir", -1]] },
  { id: "layers", group: "Form", label: "Want more layers", tip: "The whole brain should play more: more choir and brain share", push: [["bandBrain", 1], ["bandChoir", 1]] },
  { id: "tense", group: "Harmony", label: "Too tense / dissonant", tip: "Theory: too many altered tensions (b9, #11), want resolved chords", push: [["bandColor", -1], ["pain", -1]] },
  { id: "bland", group: "Harmony", label: "Harmony too plain", tip: "Theory: no tension and release, want colour and altered chords", push: [["bandColor", 1], ["jazz", 1]] },
] as const;
type HintId = (typeof HINTS)[number]["id"];
const OPPOSITE: Partial<Record<HintId, HintId>> = {
  flat: "wild", wild: "flat", dull: "harsh", harsh: "dull", stiff: "messy", messy: "stiff",
  loud: "lost", lost: "loud", thinbass: "boomy", boomy: "thinbass", washy: "dry", dry: "washy",
  mechanical: "sloppy", sloppy: "mechanical", busy: "sparse", sparse: "busy", slow: "rushed", rushed: "slow",
  samey: "unstable", unstable: "samey", tense: "bland", bland: "tense",
};
const HINT_STEP = 0.3;

const smooth = (t: number): number => t * t * (3 - 2 * t);

export class Exerciser {
  readonly specs: readonly SliderSpec[] = SLIDERS.filter((s) => !NOT_EXERCISED.includes(s.key));
  private readonly model = new TasteModel(this.specs.length);
  private readonly locked: boolean[] = this.specs.map(() => false);
  // Your own slider moves: obeyed at once (grip 1), then slowly forgotten so the exerciser can be creative again.
  private readonly grip = new Float64Array(this.specs.length);
  private readonly held = new Float64Array(this.specs.length);
  private machine = new Float64Array(this.specs.length);
  private readonly setting: Setting = { glide: 4, listen: 6, explore: 0.4, radius: 0.4, moves: 3, forget: 40 };
  private mode: Mode = "off";
  private auto = false;
  private t = 0;
  private from: Float64Array = new Float64Array(this.specs.length);
  private target: Float64Array = new Float64Array(this.specs.length);
  private changed = "";
  private dialog: HTMLDivElement | null = null;
  private dialogText: HTMLElement | null = null;
  private dialogNote: HTMLInputElement | null = null;
  private readonly status: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private lastStatus = 0;
  private readonly hints = new Set<HintId>();
  private readonly chipEls: { id: HintId; el: HTMLButtonElement }[] = [];
  private bored = false;
  // Tells which voice dominates the mix and which is buried (set by the app once the band exists).
  private mixHook: (() => { loud: string; quiet: string } | null) | null = null;
  private teachHook: ((rating: number, hints: readonly string[]) => void) | null = null;

  setMixHook(fn: () => { loud: string; quiet: string } | null): void {
    this.mixHook = fn;
  }

  /** Called with every rating and the hint chips ticked with it, so the band's personality can learn from it. */
  setTeachHook(fn: (rating: number, hints: readonly string[]) => void): void {
    this.teachHook = fn;
  }

  constructor(
    root: HTMLElement,
    private readonly params: Params,
    private readonly syncAll: () => void,
  ) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.model.load(saved, this.specs.map((s) => s.key));
    } catch {
      // storage may be blocked (private mode, file://); learning then lasts for this session only
    }

    const bar = document.createElement("div");
    bar.className = "ex-bar";
    this.startBtn = this.button("Start auto-exercise", "", () => (this.auto ? this.stop() : this.start()));
    const fav = this.button("Play my favourite", "", () => this.playFavourite());
    const reset = this.button("Forget everything", "", () => {
      this.model.clear();
      this.save();
      this.draw();
    });
    const rateLabel = document.createElement("span");
    rateLabel.textContent = "Rate what you hear now:";
    rateLabel.className = "ex-label";
    bar.append(
      this.startBtn,
      helpButton("Auto-exercise", "The exerciser moves the sliders by itself to a new, slightly different setting (a Monte Carlo guess of what you might like), lets you experience it, and then asks in a popup: No, Maybe or Yes. Every answer teaches it. Early on it explores widely; as it learns your taste it proposes more of what you liked and fewer of what you did not, while still trying new things (Exploration slider). Volume and Speed are never touched."),
      fav,
      reset,
      rateLabel,
      ...([
        ["Hellish", -0.5, "rhell"],
        ["No", 0, "rno"],
        ["Boring", 0.25, "rboring"],
        ["Maybe", 0.5, "rmaybe"],
        ["Yes", 1, "ryes"],
        ["Heavenly", 1.5, "rheaven"],
      ] as const).map(([text, r, cls]) => this.button(text, `rate ${cls}`, () => this.rate(r))),
      helpButton("Rate now", "You can teach it at any time without waiting for a question: set the sliders the way you like (or hate) and press No, Maybe or Yes. Hellish and Heavenly are optional stronger answers for the truly awful and the truly beautiful. Your own slider moves during an exercise are used too, because the answer is recorded for the setting as it is when you answer."),
    );

    const chipBar = document.createElement("div");
    chipBar.className = "ex-bar";
    const chipLabel = document.createElement("span");
    chipLabel.className = "ex-label";
    chipLabel.textContent = "What is off? (optional, then rate)";
    chipBar.append(chipLabel, ...this.chips());

    // Free-form feedback next to the preset buttons: queued, relayed to the dev relay and readable by an AI over MCP.
    const noteBar = document.createElement("div");
    noteBar.className = "ex-bar";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "ex-note";
    noteInput.placeholder = "Free note: what is missing or wrong? (queued for the AI)";
    noteInput.maxLength = 2000;
    const noteState = document.createElement("span");
    noteState.className = "ex-label";
    const sendNote = (): void => {
      if (queueNote(noteInput.value, this.noteExtra())) noteInput.value = "";
    };
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendNote();
    });
    onFeedbackChange(() => (noteState.textContent = feedbackStatus()));
    noteState.textContent = feedbackStatus();
    noteBar.append(noteInput, this.button("Send note", "small", sendNote), noteState, helpButton("Free note", "Besides the preset buttons you can write anything: what is boring, what feature is missing, what you expected to hear. Every note is stored with a snapshot of the current sliders, band, instruments and chord, and is relayed to the local dev relay (npm run relay). An AI assistant reads the queue through the relay's MCP server (npm run mcp) and analyses where the instrument really lacks built-in features. If the relay is not running the notes wait in this browser and are sent later."));

    const grid = document.createElement("div");
    grid.className = "ex-grid";
    const num = (label: string, key: keyof Setting, min: number, max: number, step: number, help: string): void => {
      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = label;
      const out = document.createElement("output");
      lab.append(name, out);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(this.setting[key]);
      out.textContent = String(this.setting[key]);
      input.addEventListener("input", () => {
        this.setting[key] = Number(input.value);
        out.textContent = input.value;
      });
      row.append(lab, input, helpButton(label, help));
      grid.append(row);
    };
    num("Glide time (s)", "glide", 0.5, 12, 0.5, "How long the sliders take to travel to the proposed setting. Slow glides sound like the tank morphing.");
    num("Listen time (s)", "listen", 1, 30, 1, "How long you get to experience the new setting before the question pops up.");
    num("Respect my moves (s)", "forget", 5, 180, 5, "When you move a slider while the exerciser runs, it obeys you at once and keeps that slider where you put it. Your move fades with this half-life, so the exerciser slowly gets its freedom back and creativity is never locked out. Your own settings are also what gets rated, so they teach the model too.");
    num("Exploration", "explore", 0, 1, 0.05, "0 = always propose what the model already expects you to like. 1 = favour settings the model is unsure about, to learn faster where your taste lies.");
    num("Step size", "radius", 0, 1, 0.05, "How far a proposal strays from the current setting. Small = fine tuning, large = big jumps.");
    num("Sliders per move", "moves", 1, 8, 1, "How many sliders a typical proposal changes at once. Few changes make it easier for the model to tell what you reacted to.");

    this.status = document.createElement("div");
    this.status.className = "ex-status";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ex-canvas";
    this.canvas.width = 640;
    this.canvas.height = 14 + this.specs.length * 9 + 22;
    this.canvas.title = "Click a row to lock or unlock that slider for the exerciser";
    this.canvas.addEventListener("click", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
      const i = Math.floor((y - 12) / 9);
      if (i >= 0 && i < this.locked.length) {
        this.locked[i] = !this.locked[i];
        this.draw();
      }
    });
    const prof = document.createElement("div");
    prof.className = "ex-prof";
    const legend = document.createElement("div");
    legend.className = "ex-legend";
    legend.innerHTML = '<i style="background:#4fd07a"></i>where Yes lives <i style="background:#ff5a3c"></i>where No lives <i style="background:#fff"></i>now · bar brightness = how much the ratings depend on the slider · click a row to lock it';
    prof.append(this.canvas, legend);
    root.append(bar, chipBar, noteBar, grid, this.status, prof);

    document.addEventListener("slider-input", (e) => this.userMoved(String((e as CustomEvent).detail)));
    document.addEventListener("keydown", (e) => {
      if (this.mode !== "ask" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || (tag === "INPUT" && (e.target as HTMLInputElement).type === "text")) return;
      const k = e.key.toLowerCase();
      if (k === "n") this.answer(0);
      else if (k === "m") this.answer(0.5);
      else if (k === "y") this.answer(1);
      else if (k === "b") this.answer(0.25);
      else if (k === "h") this.answer(1.5);
      else if (k === "l") this.answer(-0.5);
    });
    this.draw();
    this.updateStatus(true);
  }

  private chips(): HTMLElement[] {
    const rows = new Map<string, HTMLElement>();
    for (const h of HINTS) {
      let row = rows.get(h.group);
      if (!row) {
        row = document.createElement("div");
        row.className = "ex-bar chip-group";
        const name = document.createElement("span");
        name.className = "chip-group-name";
        name.textContent = h.group;
        row.append(name);
        rows.set(h.group, row);
      }
      const el = this.button(h.label, "small chip", () => {
        if (this.hints.has(h.id)) this.hints.delete(h.id);
        else {
          this.hints.add(h.id);
          const opp = OPPOSITE[h.id];
          if (opp) this.hints.delete(opp);
        }
        this.syncChips();
      });
      el.title = h.tip;
      el.setAttribute("aria-pressed", "false");
      this.chipEls.push({ id: h.id, el });
      row.append(el);
    }
    return [...rows.values()];
  }

  private syncChips(): void {
    for (const c of this.chipEls) {
      const on = this.hints.has(c.id);
      c.el.classList.toggle("on", on);
      c.el.setAttribute("aria-pressed", String(on));
    }
  }

  /** Moves the sliders named by the pending hints, then forgets the hints. Returns the changed vector. */
  private biased(x: Float64Array): Float64Array {
    const out = Float64Array.from(x);
    const hints = new Set(this.hints);
    if (this.bored) hints.add("flat");
    for (const h of HINTS) {
      if (!hints.has(h.id)) continue;
      for (const [rawKey, dir] of h.push) {
        let key: string = rawKey;
        if (rawKey === "@loud" || rawKey === "@quiet") {
          const d = this.mixHook?.();
          if (!d) continue;
          key = rawKey === "@loud" ? d.loud : d.quiet;
        }
        const k = this.specs.findIndex((s) => s.key === key);
        if (k >= 0 && !this.locked[k]) out[k] = Math.min(1, Math.max(0, (out[k] ?? 0) + dir * HINT_STEP));
      }
    }
    this.hints.clear();
    this.syncChips();
    return out;
  }

  private button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `btn ${cls}`.trim();
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  private vector(): Float64Array {
    return Float64Array.from(this.specs, (s) => (Number(this.params[s.key]) - s.min) / (s.max - s.min));
  }

  /** The human touched a slider: take over that slider now; the grip fades with time. */
  private userMoved(key: string): void {
    const i = this.specs.findIndex((s) => s.key === key);
    const s = this.specs[i];
    if (!s || this.mode === "off") return;
    this.held[i] = (Number(this.params[s.key]) - s.min) / (s.max - s.min);
    this.grip[i] = 1;
    if (this.mode === "listen") this.t = 0; // keep listening while the human is still tuning
  }

  private gripped(): boolean {
    return this.grip.some((g) => g > 0.02);
  }

  private apply(x: ArrayLike<number>): void {
    this.machine = Float64Array.from(x);
    this.specs.forEach((s, i) => {
      if (this.locked[i]) return;
      const g = this.grip[i] ?? 0;
      const m = (x[i] ?? 0) * (1 - g) + (this.held[i] ?? 0) * g;
      const v = s.min + Math.min(1, Math.max(0, m)) * (s.max - s.min);
      this.params[s.key] = Math.round(v / s.step) * s.step;
    });
    this.syncAll();
  }

  /** Called whenever the running state changes, so other buttons can mirror it. */
  onState: (running: boolean) => void = () => {};

  get running(): boolean {
    return this.auto;
  }

  toggle(): void {
    if (this.auto) this.stop();
    else this.start();
  }

  start(): void {
    this.auto = true;
    this.startBtn.textContent = "Stop auto-exercise";
    this.startBtn.classList.add("on");
    this.onState(true);
    this.propose();
  }

  stop(): void {
    this.auto = false;
    this.mode = "off";
    this.grip.fill(0);
    this.closeDialog();
    this.startBtn.textContent = "Start auto-exercise";
    this.startBtn.classList.remove("on");
    this.onState(false);
    this.updateStatus(true);
  }

  /** Pops the Yes/Maybe/No question immediately for the current setting. */
  askNow(): void {
    if (!this.auto) {
      this.auto = true;
      this.startBtn.textContent = "Stop auto-exercise";
      this.startBtn.classList.add("on");
      this.onState(true);
    }
    this.t = 0;
    this.ask();
  }

  private propose(): void {
    const cur = this.vector();
    const explore = this.bored ? Math.min(1, this.setting.explore + 0.4) : this.setting.explore;
    const s = this.model.suggest(cur, { ...this.setting, explore, locked: this.locked });
    const to = this.biased(s.x);
    this.grip.forEach((g, i) => {
      to[i] = (to[i] ?? 0) * (1 - g) + (this.held[i] ?? 0) * g;
      this.grip[i] = g * 0.75;
    });
    this.glideTo(cur, to);
    this.bored = false;
  }

  private glideTo(from: Float64Array, to: Float64Array): void {
    this.from = from;
    this.target = to;
    this.machine = Float64Array.from(to);
    const diffs = this.specs
      .map((s, i) => ({ s, d: (to[i] ?? 0) - (from[i] ?? 0) }))
      .filter((x) => Math.abs(x.d) > 0.02)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 4);
    this.changed = diffs.map((x) => `${x.s.label} ${x.d > 0 ? "up" : "down"}`).join(", ");
    this.t = 0;
    this.mode = "glide";
  }

  private playFavourite(): void {
    const cur = this.vector();
    const fav = this.model.favourite({ locked: this.locked }, cur);
    if (!fav) {
      this.status.textContent = "Not enough ratings yet: rate at least 3 settings first.";
      return;
    }
    if (this.auto) this.stop();
    this.glideTo(cur, fav.x);
    this.changed = "your favourite so far";
  }

  /** Advance the exerciser by dt seconds. Called every animation frame. */
  update(dt: number): void {
    if (this.mode === "off") this.grip.fill(0);
    else if (this.gripped()) {
      const keep = Math.pow(0.5, dt / Math.max(1, this.setting.forget));
      this.grip.forEach((g, i) => (this.grip[i] = g * keep < 0.02 ? 0 : g * keep));
      if (this.mode !== "glide") this.apply(this.machine);
    }
    if (this.mode === "glide") {
      this.t += dt;
      const k = smooth(Math.min(1, this.t / Math.max(0.1, this.setting.glide)));
      this.apply(Float64Array.from(this.target, (to, i) => (this.from[i] ?? 0) + (to - (this.from[i] ?? 0)) * k));
      if (this.t >= this.setting.glide) {
        this.t = 0;
        this.mode = this.auto ? "listen" : "off";
      }
    } else if (this.mode === "listen") {
      this.t += dt;
      if (this.t >= this.setting.listen) this.ask();
    }
    this.updateStatus(false);
  }

  private ask(): void {
    this.mode = "ask";
    this.closeDialog();
    const d = document.createElement("div");
    d.className = "taste-dialog";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-label", "Do you like this setting?");
    const h = document.createElement("strong");
    h.textContent = "Do you like this?";
    const p = document.createElement("p");
    this.dialogText = p;
    const row = document.createElement("div");
    row.className = "ex-bar";
    const mk = (label: string, key: string, r: Rating, cls: string): HTMLButtonElement => this.button(`${label} (${key})`, `rate ${cls}`, () => this.answer(r));
    const stop = this.button("Stop", "small", () => this.stop());
    row.append(mk("Boring", "B", 0.25, "rboring"), mk("No", "N", 0, "rno"), mk("Maybe", "M", 0.5, "rmaybe"), mk("Yes", "Y", 1, "ryes"), stop);
    const more = document.createElement("div");
    more.className = "ex-bar";
    const strong = (label: string, key: string, r: Rating, cls: string, tip: string): HTMLButtonElement => {
      const b = this.button(label, `rate ${cls}`, () => this.answer(r));
      b.title = `${tip} (optional shortcut: ${key})`;
      return b;
    };
    more.append(
      strong("Hellish", "L", -0.5, "rhell", "Truly awful, never again"),
      strong("Heavenly", "H", 1.5, "rheaven", "Truly beautiful, more of this"),
    );
    const offLabel = document.createElement("p");
    offLabel.textContent = "What is off? Tap, then answer above (optional):";
    const offRow = document.createElement("div");
    offRow.className = "ex-bar";
    offRow.append(...this.chips());
    const note = document.createElement("input");
    note.type = "text";
    note.className = "ex-note";
    note.placeholder = "Or write it: what is boring or missing? (optional)";
    note.maxLength = 2000;
    this.dialogNote = note;
    d.append(h, p, row, more, offLabel, offRow, note);
    this.syncChips();
    document.body.append(d);
    this.dialog = d;
    this.refreshDialogText();
  }

  private refreshDialogText(): void {
    if (!this.dialogText) return;
    const { mean, std } = this.model.predict(this.vector());
    const guess = this.model.count < 3 ? "still learning, no guess yet" : `I guessed you would say Yes with ${(Math.min(1, Math.max(0, mean)) * 100).toFixed(0)}% (±${(std * 50).toFixed(0)})`;
    this.dialogText.textContent = `${this.changed ? `Changed: ${this.changed}. ` : ""}${guess}.`;
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
    this.dialogText = null;
    this.dialogNote = null;
  }

  private noteExtra(rating?: Rating): { rating?: string; hints?: string[] } {
    const extra: { rating?: string; hints?: string[] } = { hints: [...this.hints] };
    const name = rating === undefined ? undefined : RATING_NAME.get(rating);
    if (name) extra.rating = name;
    return extra;
  }

  private answer(r: Rating): void {
    if (this.mode !== "ask") return;
    const text = this.dialogNote?.value ?? "";
    queueNote(text, this.noteExtra(r));
    this.closeDialog();
    this.rate(r);
    if (this.auto) this.propose();
    else this.mode = "off";
  }

  /** A "nice" (true) or "try again" (false) click from the top bar: a soft vote for the current setting in the taste model. */
  cheer(nice: boolean): void {
    this.model.add(this.vector(), nice ? 1 : 0.25);
    this.save();
    this.draw();
    this.updateStatus(true);
  }

  /** Records a rating for the setting as it is right now. */
  rate(r: Rating): void {
    this.teachHook?.(r, [...this.hints]);
    this.model.add(this.vector(), r);
    if (r === 0.25) this.bored = true;
    if (!this.auto && (this.hints.size > 0 || this.bored)) {
      this.apply(this.biased(this.vector()));
      this.bored = false;
    }
    this.save();
    this.draw();
    this.updateStatus(true);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, this.model.toJSON(this.specs.map((s) => s.key)));
    } catch {
      // see constructor
    }
  }

  private updateStatus(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastStatus < 400) return;
    this.lastStatus = now;
    const n = this.model.count;
    const yes = this.model.samples.filter((s) => s.y >= 1).length;
    const no = this.model.samples.filter((s) => s.y <= 0).length;
    const boring = this.model.samples.filter((s) => s.y === 0.25).length;
    const heaven = this.model.samples.filter((s) => s.y > 1).length;
    const hell = this.model.samples.filter((s) => s.y < 0).length;
    const guess = n >= 3 ? ` · model says you would rate the current setting ${(Math.min(1, Math.max(0, this.model.predict(this.vector()).mean)) * 100).toFixed(0)}% Yes` : "";
    let state = "idle";
    if (this.mode === "glide") state = `gliding ${(Math.min(1, this.t / this.setting.glide) * 100).toFixed(0)}%`;
    else if (this.mode === "listen") state = `listen... ${Math.max(0, this.setting.listen - this.t).toFixed(0)}s to the question`;
    else if (this.mode === "ask") state = "waiting for your answer";
    const steer = this.grip.filter((g) => g > 0.02).length;
    if (steer) state += ` · you steer ${steer} slider${steer > 1 ? "s" : ""} (fading)`;
    this.status.textContent = `Ratings ${n} (Boring ${boring} · Yes ${yes}${heaven ? ` of which ${heaven} Heavenly` : ""} · Maybe ${n - yes - no - boring} · No ${no}${hell ? ` of which ${hell} Hellish` : ""}) · ${state}${guess}`;
    if (this.mode === "ask") this.refreshDialogText();
    if (force || this.mode === "glide" || this.mode === "listen" || this.gripped()) this.draw();
  }

  /** Taste profile: per slider, where Yes and No ratings live, plus the current value. */
  draw(): void {
    const c = this.canvas.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = this.canvas;
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    c.font = "9px system-ui";
    const x0 = 190;
    const bw = w - x0 - 10;
    const prof = this.model.profile();
    const cur = this.vector();
    const rel = this.model.relevance;
    this.specs.forEach((s, i) => {
      const y = 12 + i * 9;
      const lock = this.locked[i] === true;
      const g = this.grip[i] ?? 0;
      c.fillStyle = lock ? "#5a6577" : g > 0.02 ? "#ffb347" : "#93a0b3";
      c.fillText(`${lock ? "🔒 " : ""}${s.label}${g > 0.02 ? ` (you ${(g * 100).toFixed(0)}%)` : ""}`, 4, y + 6);
      const a = Math.min(1, 0.25 + 0.45 * (rel[i] ?? 1));
      c.fillStyle = `rgba(80,100,140,${lock ? 0.15 : a})`;
      c.fillRect(x0, y + 1, bw, 6);
      const mark = (v: number | null | undefined, col: string): void => {
        if (v === null || v === undefined) return;
        c.fillStyle = col;
        c.fillRect(x0 + v * bw - 1.5, y - 1, 3, 10);
      };
      mark(prof.no[i], "#ff5a3c");
      mark(prof.yes[i], "#4fd07a");
      c.fillStyle = "#fff";
      c.fillRect(x0 + (cur[i] ?? 0) * bw - 0.5, y, 1.5, 8);
    });
    const hy = h - 12;
    const recent = this.model.samples.slice(-64);
    recent.forEach((s, i) => {
      c.fillStyle = s.y > 1 ? "#7fe8ff" : s.y === 1 ? "#4fd07a" : s.y === 0.25 ? "#8a8f99" : s.y < 0 ? "#a01818" : s.y === 0 ? "#ff5a3c" : "#e0b040";
      c.fillRect(x0 + i * (bw / 64), hy, bw / 64 - 1, 8);
    });
    c.fillStyle = "#93a0b3";
    c.fillText("history", 4, hy + 7);
  }
}
