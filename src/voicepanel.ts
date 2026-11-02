// "Voice in" and the beat: the microphone as input of layer 1 (Physical). Sung notes (voice2midi) and unpitched bursts ("pfff"
// becomes a drum stick) strike the bottom tank and the brain answers a few slots later. The human follows the machine: a
// beat cue (dots plus a ring that closes on the next beat) and a timing meter show how early or late you are. Below it the
// beat lattice (ten layers) and the 4D time view of the stack.

import type { BeatLattice, Groove } from "./beat";
import type { Tesseract } from "./tesseract";
import { strictness, tuneNote, type TuneChord } from "./tuner";
import { TempoTracker, VoiceInput, type VoiceEvent, type VoiceFrame } from "./voice";

/** Onset detection takes about this long; the sound happened this much before the event arrived. */
const DETECT_DELAY = 0.045;

export interface BeatPos {
  phase: number;
  beat: number;
  bar: number;
  /** True when the phase comes from the audible band; false when it is the free-running lattice (sound is off). */
  audible: boolean;
}

export interface VoiceDeps {
  lattice: BeatLattice;
  groove: Groove;
  cube: Tesseract;
  /** Strikes layer 1 at a normalised position. */
  strike(x: number, y: number, amp: number): void;
  note(midi: number, vel: number, monitor: boolean): void;
  /** The chord the band plays now. */
  chord(): TuneChord & { name: string };
  /** Harmonic colour 0..1 (sweet to tense): the jazzier, the more relaxed the tuner. */
  colour(): number;
  tuneLevel(): number;
  setTuneLevel(v: number): void;
  hit(vel: number, bright: number): void;
  bpm(): number;
  /** The machine beat as heard `ago` seconds before now. */
  beatPos(ago: number): BeatPos;
  /** Sets the band tempo (machine follows me). */
  setTempo(bpm: number): void;
  /** A human onset landed on the beat. */
  onBeat(): void;
  /** Called when the microphone is running (turn the band on so you hear the answer). */
  started(): void;
}

export interface VoicePanel {
  /** Redraw; call once per animation frame. */
  update(): void;
  info(): Record<string, unknown>;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (m: number): string => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function buildVoicePanel(root: HTMLElement, deps: VoiceDeps): VoicePanel {
  const voice = new VoiceInput();
  const tempo = new TempoTracker();
  let counts = { notes: 0, hits: 0, staccato: 0 };
  let lastHold = 0;
  let lastOffset: { ms: number; at: number } | null = null;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const canvasOf = (w: number, h: number, label: string): HTMLCanvasElement => {
    const c = el("canvas", "voice-lattice");
    c.width = w;
    c.height = h;
    c.setAttribute("aria-label", label);
    return c;
  };
  const check = (text: string, on: boolean): { label: HTMLLabelElement; box: HTMLInputElement } => {
    const label = el("label", "voice-opt");
    const box = el("input");
    box.type = "checkbox";
    box.checked = on;
    label.append(box, ` ${text}`);
    return { label, box };
  };

  const row = el("div", "voice-row");
  const mic = el("button", "btn small", "Mic: Start");
  mic.type = "button";
  const monitor = check("hear my voice as instruments", true);
  const follow = check("machine follows my tempo (off: you follow the machine)", false);
  const sensLabel = el("label", "voice-opt", "noise gate ");
  const sens = el("input");
  sens.type = "range";
  sens.min = "0.5";
  sens.max = "4";
  sens.step = "0.1";
  sens.value = "1";
  sensLabel.append(sens);
  const tuneLabel = el("label", "voice-opt", "tune-in ");
  const tune = el("input");
  tune.type = "range";
  tune.min = "0";
  tune.max = "1";
  tune.step = "0.01";
  tune.value = String(deps.tuneLevel());
  tune.title = "Auto-tuner: pulls what you sing to the chord and riff that play now. 0 = raw, 1 = strictly chord tones. The jazzier (harmonic colour) the band, the more relaxed it is: tensions and passing notes stay.";
  tuneLabel.append(tune);
  const tuneRead = el("div", "voice-read", "Auto-tuner: waiting for a note.");
  row.append(mic, monitor.label, follow.label, sensLabel, tuneLabel);
  const read = el("div", "voice-read", "Microphone off. Use headphones: the band would otherwise be heard by the microphone. Sing or hum single notes, say \"ta ta\" (short notes are staccato), or blow \"pfff\" / \"tss\" for drum sticks. Follow the beat cue below.");
  const cue = canvasOf(360, 52, "Beat cue and timing meter");
  const timing = el("div", "voice-read");
  const lattice = canvasOf(360, 64, "Beat of the ten layers");
  const meta = el("div", "voice-read");
  const cube = canvasOf(360, 110, "Four-dimensional view: layers over time");
  const cubeMeta = el("div", "voice-read");
  root.append(row, read, tuneRead, cue, timing, lattice, meta, cube, cubeMeta);

  let last = "";
  const onEvent = (e: VoiceEvent): void => {
    if (e.kind === "off") {
      if (e.staccato) counts.staccato++;
      return;
    }
    if (e.kind === "on") {
      counts.notes++;
      const t = tuneNote(e.midi, deps.chord(), deps.tuneLevel(), deps.colour());
      deps.strike(clamp01(0.1 + (0.8 * (t.midi - 36)) / 48), 0.1 + 0.8 * (((t.midi % 12) + 12) % 12) / 12, 0.5 + (0.9 * e.vel) / 127);
      deps.note(t.midi, e.vel, monitor.box.checked);
      last = `note ${noteName(e.midi)}${t.shift !== 0 ? ` → ${noteName(t.midi)}` : ""} (vel ${e.vel})`;
      tuneRead.textContent = `Auto-tuner on ${deps.chord().name}: you sang ${noteName(e.midi)}, the band hears ${noteName(t.midi)} (${t.kind === "chord" ? "chord tone" : t.kind === "scale" ? "scale tone / tension" : "passing note"}${t.shift !== 0 ? `, pulled ${t.shift > 0 ? "+" : ""}${t.shift} semitone${Math.abs(t.shift) > 1 ? "s" : ""}` : ", left as it was"}). Strictness ${(strictness(deps.tuneLevel(), deps.colour()) * 100).toFixed(0)}%.`;
    } else {
      counts.hits++;
      deps.strike(0.5 + 0.7 * (e.bright - 0.5), 0.5, 0.5 + (0.9 * e.vel) / 127);
      deps.hit(e.vel, e.bright);
      last = `stick (vel ${e.vel}, ${e.bright > 0.6 ? "bright" : "dull"})`;
    }
    const bpm = deps.bpm();
    const r = deps.groove.push(deps.beatPos(DETECT_DELAY).phase, bpm);
    lastOffset = { ms: r.ms, at: performance.now() };
    if (r.hit) deps.onBeat();
    tempo.push(e.t);
    if (follow.box.checked) {
      const b = tempo.bpm();
      if (b !== null) deps.setTempo(b);
    }
  };

  const onFrame = (f: VoiceFrame): void => {
    const now = performance.now();
    if (f.state === "voiced" && f.midiNote >= 0 && now - lastHold > 140) {
      lastHold = now; // a held note keeps the bottom tank excited at its place
      const held = tuneNote(f.midiNote, deps.chord(), deps.tuneLevel(), deps.colour()).midi;
      deps.strike(clamp01(0.1 + (0.8 * (held - 36)) / 48), 0.1 + 0.8 * (((held % 12) + 12) % 12) / 12, 0.1 + 2 * f.level);
    }
    const goal = f.hz > 0 && f.midiNote >= 0 ? tuneNote(f.midiNote, deps.chord(), deps.tuneLevel(), deps.colour()).midi : null;
    const cents = f.hz > 0 ? Math.round((f.midi - Math.round(f.midi)) * 100) : 0;
    const bar = "█".repeat(Math.round(clamp01((f.db + 60) / 60) * 12)).padEnd(12, "░");
    read.textContent = `${bar} ${f.state === "voiced" ? `${noteName(f.midiNote)}${goal !== null && goal !== f.midiNote ? `→${noteName(goal)}` : ""} ${f.hz.toFixed(0)} Hz ${cents >= 0 ? "+" : ""}${cents} cents` : f.state === "noise" ? "burst" : f.level > 0.01 ? "listening" : "quiet"} · last: ${last || "-"}`;
  };

  mic.addEventListener("click", () => {
    if (voice.running) {
      voice.stop();
      mic.textContent = "Mic: Start";
      mic.classList.remove("on");
      read.textContent = "Microphone off.";
      return;
    }
    voice.onEvent = onEvent;
    voice.onFrame = onFrame;
    voice
      .start()
      .then(() => {
        mic.textContent = "Mic: Stop";
        mic.classList.add("on");
        counts = { notes: 0, hits: 0, staccato: 0 };
        deps.started();
      })
      .catch((e: unknown) => {
        read.textContent = `No microphone: ${e instanceof Error ? e.message : "refused"}. The page needs https or localhost and your permission.`;
      });
  });
  tune.addEventListener("input", () => deps.setTuneLevel(Number(tune.value)));
  sens.addEventListener("input", () => {
    if (voice.analyzer) voice.analyzer.gateScale = Number(sens.value);
  });

  const drawCue = (): void => {
    const c = cue.getContext("2d");
    if (!c) return;
    const { width: w, height: h } = cue;
    const b = deps.beatPos(0);
    c.fillStyle = "#090d13";
    c.fillRect(0, 0, w, h);
    // four beats of the bar; the current one lights up, a ring closes on the next beat
    for (let i = 0; i < 4; i++) {
      const x = 26 + i * 44;
      const cur = i === b.beat;
      const flash = cur ? (1 - b.phase) ** 2 : 0;
      c.beginPath();
      c.arc(x, 26, 12, 0, 2 * Math.PI);
      c.fillStyle = cur ? `rgba(255,${200 + 40 * flash},${120 * flash + 60},${0.35 + 0.65 * flash})` : i === 0 ? "#2b3550" : "#1b2434";
      c.fill();
      if (i === (b.beat + 1) % 4) {
        c.beginPath();
        c.arc(x, 26, 12 + 14 * (1 - b.phase), 0, 2 * Math.PI);
        c.strokeStyle = `rgba(150,190,255,${0.2 + 0.7 * b.phase})`;
        c.lineWidth = 1.5;
        c.stroke();
      }
    }
    c.fillStyle = "#93a0b3";
    c.font = "9px system-ui";
    c.fillText(`bar ${b.bar + 1} · beat ${b.beat + 1}${b.audible ? "" : " (silent: sound is off)"} · ${deps.lattice.dir > 0 ? "beat climbs ↑" : "beat descends ↓"}`, 6, 10);
    // timing meter: -100..+100 ms
    const mx0 = 200;
    const mw = w - mx0 - 10;
    const xOf = (ms: number): number => mx0 + mw / 2 + (Math.max(-100, Math.min(100, ms)) / 100) * (mw / 2);
    c.fillStyle = "rgba(90,200,140,0.18)";
    c.fillRect(xOf(-70), 18, xOf(70) - xOf(-70), 22);
    c.fillStyle = "#4a5670";
    c.fillRect(xOf(0) - 1, 14, 2, 30);
    c.fillStyle = "#93a0b3";
    c.fillText("early", mx0, 50);
    c.fillText("late", w - 28, 50);
    const offs = deps.groove.offsets;
    offs.forEach((ms, i) => {
      const age = (i + 1) / offs.length;
      c.fillStyle = `rgba(255,230,140,${0.15 + 0.85 * age})`;
      c.beginPath();
      c.arc(xOf(ms), 29, 2 + 3 * age * age, 0, 2 * Math.PI);
      c.fill();
    });
  };

  let draws = 0;
  return {
    update(): void {
      if (++draws % 2 !== 0) return;
      drawCue();
      const s = deps.groove.stats();
      const lo = lastOffset;
      timing.textContent = s
        ? `you: ${s.bias >= 0 ? "+" : ""}${s.bias.toFixed(0)} ms (${s.bias >= 0 ? "late" : "early"} on average) · jitter ${s.jitter.toFixed(0)} ms · ${Math.round(s.onBeat * 100)}% on the beat (±${70} ms) · last ${lo ? `${lo.ms >= 0 ? "+" : ""}${lo.ms.toFixed(0)} ms` : "-"}`
        : "Timing: make 3 sounds (sing, say \"ta\", clap) against the beat cue. You follow the machine; each hit on the beat gives the brain a little reward.";
      const c = lattice.getContext("2d");
      if (!c) return;
      const { width: w, height: h } = lattice;
      c.fillStyle = "#090d13";
      c.fillRect(0, 0, w, h);
      const n = deps.lattice.phase.length;
      for (let l = 0; l < n; l++) {
        const v = deps.lattice.level(l);
        const x = 14 + (l * (w - 28)) / (n - 1);
        c.fillStyle = `hsl(${30 + l * 18},80%,${25 + 40 * v}%)`;
        const bh = 6 + (h - 24) * v;
        c.fillRect(x - 11, h - 14 - bh, 22, bh);
        c.fillStyle = "#93a0b3";
        c.font = "9px system-ui";
        c.fillText(`L${l + 1}`, x - 8, h - 3);
      }
      const b = tempo.bpm();
      meta.textContent = `beat lattice sync ${Math.round(deps.lattice.order * 100)}% at ${deps.bpm().toFixed(0)} bpm · your tempo ${b ? `${b.toFixed(0)} bpm` : "(need 5 onsets)"} · ${counts.notes} notes, ${counts.staccato} staccato, ${counts.hits} sticks`;
      deps.cube.draw(cube);
      const i = deps.cube.info();
      const top = i.beatSync.reduce((m, v, l) => (v > (i.beatSync[m] ?? 0) ? l : m), 0);
      cubeMeta.textContent = `4D (x·y·layers·5 s): vertical flow ${i.flowMs === null ? "no clear direction yet" : `${i.flowMs >= 0 ? "up" : "down"} ${Math.abs(i.flowMs).toFixed(0)} ms/layer`} · neighbour-layer field sync ${Math.round(i.verticalSync * 100)}% · best on the beat: L${top + 1} (${Math.round((i.beatSync[top] ?? 0) * 100)}%)`;
    },
    info(): Record<string, unknown> {
      return { mic: voice.running, ...counts, yourBpm: tempo.bpm(), latticeSync: Number(deps.lattice.order.toFixed(2)), last, timing: deps.groove.stats() };
    },
  };
}
