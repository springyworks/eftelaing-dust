// "Voice in": the microphone as input of layer 1 (Physical). Sung notes (voice2midi) and unpitched bursts ("pfff" becomes a
// drum stick) strike the bottom tank, the brain answers a few slots later, and the beat lattice shows the beat running up
// and down the ten layers, pulled onto your onsets.

import { BeatLattice } from "./beat";
import { TempoTracker, VoiceInput, type VoiceEvent, type VoiceFrame } from "./voice";

export interface VoiceDeps {
  /** Strikes layer 1 at a normalised position. */
  strike(x: number, y: number, amp: number): void;
  note(midi: number, vel: number, monitor: boolean): void;
  hit(vel: number, bright: number): void;
  bpm(): number;
  /** Sets the band tempo (follow my tempo). */
  setTempo(bpm: number): void;
  /** Called when the microphone is running (turn the band on so you hear the answer). */
  started(): void;
}

export interface VoicePanel {
  /** Advance the beat lattice and redraw; call once per animation frame. */
  update(dt: number): void;
  info(): Record<string, unknown>;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (m: number): string => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function buildVoicePanel(root: HTMLElement, deps: VoiceDeps): VoicePanel {
  const voice = new VoiceInput();
  const tempo = new TempoTracker();
  const lattice = new BeatLattice();
  let counts = { notes: 0, hits: 0, staccato: 0 };
  let lastHold = 0;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const row = el("div", "voice-row");
  const mic = el("button", "btn small", "Mic: Start");
  mic.type = "button";
  const monLabel = el("label", "voice-opt");
  const monitor = el("input");
  monitor.type = "checkbox";
  monitor.checked = true;
  monLabel.append(monitor, " hear my voice as instruments");
  const followLabel = el("label", "voice-opt");
  const follow = el("input");
  follow.type = "checkbox";
  followLabel.append(follow, " follow my tempo");
  const sensLabel = el("label", "voice-opt", "noise gate ");
  const sens = el("input");
  sens.type = "range";
  sens.min = "0.5";
  sens.max = "4";
  sens.step = "0.1";
  sens.value = "1";
  sensLabel.append(sens);
  row.append(mic, monLabel, followLabel, sensLabel);
  const read = el("div", "voice-read", "Microphone off. Use headphones: the band would otherwise be heard by the microphone. Sing or hum single notes, say \"ta ta\" (short notes are staccato), or blow \"pfff\" / \"tss\" for drum sticks.");
  read.setAttribute("aria-live", "off");
  const canvas = el("canvas", "voice-lattice");
  canvas.width = 360;
  canvas.height = 64;
  canvas.setAttribute("aria-label", "Beat of the ten layers");
  const meta = el("div", "voice-read");
  root.append(row, read, canvas, meta);

  let last = "";
  const onEvent = (e: VoiceEvent): void => {
    if (e.kind === "on") {
      counts.notes++;
      deps.strike(clamp01(0.1 + (0.8 * (e.midi - 36)) / 48), 0.1 + 0.8 * (((e.midi % 12) + 12) % 12) / 12, 0.5 + (0.9 * e.vel) / 127);
      deps.note(e.midi, e.vel, monitor.checked);
      last = `note ${noteName(e.midi)} (vel ${e.vel})`;
    } else if (e.kind === "hit") {
      counts.hits++;
      deps.strike(0.5 + 0.35 * (e.bright - 0.5) * 2, 0.5, 0.5 + (0.9 * e.vel) / 127);
      deps.hit(e.vel, e.bright);
      last = `stick (vel ${e.vel}, ${e.bright > 0.6 ? "bright" : "dull"})`;
    } else {
      if (e.staccato) counts.staccato++;
      return;
    }
    tempo.push(e.t);
    lattice.pull(0.5);
    if (follow.checked) {
      const b = tempo.bpm();
      if (b !== null) deps.setTempo(b);
    }
  };

  const onFrame = (f: VoiceFrame): void => {
    const now = performance.now();
    if (f.state === "voiced" && f.midiNote >= 0 && now - lastHold > 140) {
      lastHold = now; // a held note keeps the bottom tank excited at its place
      deps.strike(clamp01(0.1 + (0.8 * (f.midi - 36)) / 48), 0.1 + 0.8 * (((f.midiNote % 12) + 12) % 12) / 12, 0.1 + 2 * f.level);
    }
    const cents = f.hz > 0 ? Math.round((f.midi - Math.round(f.midi)) * 100) : 0;
    const bar = "█".repeat(Math.round(clamp01((f.db + 60) / 60) * 12)).padEnd(12, "░");
    read.textContent = `${bar} ${f.state === "voiced" ? `${noteName(f.midiNote)} ${f.hz.toFixed(0)} Hz ${cents >= 0 ? "+" : ""}${cents} cents` : f.state === "noise" ? "burst" : f.level > 0.01 ? "listening" : "quiet"} · last: ${last || "-"}`;
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
  sens.addEventListener("input", () => {
    if (voice.analyzer) voice.analyzer.gateScale = Number(sens.value);
  });

  let draws = 0;
  return {
    update(dt: number): void {
      lattice.step(dt, deps.bpm());
      if (++draws % 2 !== 0) return;
      const c = canvas.getContext("2d");
      if (!c) return;
      const { width: w, height: h } = canvas;
      c.fillStyle = "#090d13";
      c.fillRect(0, 0, w, h);
      const n = lattice.phase.length;
      for (let l = 0; l < n; l++) {
        const v = lattice.level(l);
        const x = 14 + (l * (w - 28)) / (n - 1);
        c.fillStyle = `hsl(${30 + l * 18},80%,${25 + 40 * v}%)`;
        const bh = 6 + (h - 24) * v;
        c.fillRect(x - 11, h - 14 - bh, 22, bh);
        c.fillStyle = "#93a0b3";
        c.font = "9px system-ui";
        c.fillText(`L${l + 1}`, x - 8, h - 3);
      }
      const b = tempo.bpm();
      meta.textContent = `beat lattice sync ${Math.round(lattice.order * 100)}% at ${deps.bpm().toFixed(0)} bpm · your tempo ${b ? `${b.toFixed(0)} bpm` : "(need 5 onsets)"} · ${counts.notes} notes, ${counts.staccato} staccato, ${counts.hits} sticks`;
    },
    info(): Record<string, unknown> {
      return { mic: voice.running, ...counts, yourBpm: tempo.bpm(), latticeSync: Number(lattice.order.toFixed(2)), last };
    },
  };
}
