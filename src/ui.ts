// Control panel construction with per-control help popups.

import type { ContextMode, Dimension, ListenMode, MatrixView, Params } from "./model";

type NumKey = Exclude<{ [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params], "dimension">;

interface SliderSpec {
  readonly kind: "slider";
  readonly key: NumKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly help: string;
}

interface SelectSpec {
  readonly kind: "select";
  readonly key: "dimension" | "context" | "listen" | "matrixView";
  readonly label: string;
  readonly options: readonly { value: string; text: string }[];
  readonly help: string;
}

type Spec = SliderSpec | SelectSpec;

interface Group {
  readonly title: string;
  readonly specs: readonly Spec[];
}

const GROUPS: readonly Group[] = [
  {
    title: "Simulation",
    specs: [
      { kind: "slider", key: "speed", label: "Speed", min: 0.1, max: 8, step: 0.1, help: "Simulation steps per animation frame. Below 1 gives slow motion; 8 is fast forward." },
      {
        kind: "select",
        key: "dimension",
        label: "Tank dimension (n)",
        options: [
          { value: "1", text: "1D string" },
          { value: "2", text: "2D ripple tank" },
          { value: "3", text: "3D volume (mid slice shown)" },
        ],
        help: "Every layer holds an n-dimensional wave medium. Changing n rebuilds all ten tanks. In 3D the mid-plane slice is displayed.",
      },
      { kind: "slider", key: "damping", label: "Intrinsic damping", min: 0, max: 0.05, step: 0.001, help: "Friction in every layer. Low values let waves ring for a long time, so layers stay excited and couple strongly." },
    ],
  },
  {
    title: "Stabilisation and coupling",
    specs: [
      { kind: "slider", key: "stabilization", label: "Stabilisation from below", min: 0, max: 1, step: 0.01, help: "How strongly layer N-1 steadies layer N (extra damping and a restoring force). A noisy lower layer lowers the stability of everything above it." },
      { kind: "slider", key: "couplingUp", label: "Coupling bottom-up", min: 0, max: 1, step: 0.01, help: "Strength with which a lower layer's wave field pulls on the layer above: the instrument sounds into the player." },
      { kind: "slider", key: "couplingDown", label: "Coupling top-down", min: 0, max: 1, step: 0.01, help: "Strength with which an upper layer pulls on the one below: the director conducts the players, who play the instrument. The two couplings are kept within a 2:1 ratio so the stack stays energy-consistent." },
    ],
  },
  {
    title: "Instrument, Player, Director",
    specs: [
      { kind: "slider", key: "instrumentDrive", label: "Instrument drive (L1-L7)", min: 0, max: 1, step: 0.01, help: "Baseline excitation of the OSI layers, each at its own pitch. The hum of the instrument." },
      { kind: "slider", key: "playerActivity", label: "Player activity (L8)", min: 0, max: 1, step: 0.01, help: "Two counter-rotating emitters in layer 8: agency and technique." },
      { kind: "slider", key: "directorIntent", label: "Director intent (L10)", min: 0, max: 1, step: 0.01, help: "Slow phrased excitation of layer 10, the top-down source of meaning." },
    ],
  },
  {
    title: "Layer 9: feelings",
    specs: [
      { kind: "slider", key: "pain", label: "Pain", min: 0, max: 1, step: 0.01, help: "Sharp, high-frequency bursts at jumping locations. Dissonant in sound, and destabilising for the layers above." },
      { kind: "slider", key: "delight", label: "Delight", min: 0, max: 1, step: 0.01, help: "Smooth, wide, steady source in the middle of the tank, at the layer's natural pitch." },
      { kind: "slider", key: "interest", label: "Interest", min: 0, max: 1, step: 0.01, help: "A focused, slow source at a fixed point of attention." },
      { kind: "slider", key: "curiosity", label: "Curiosity", min: 0, max: 1, step: 0.01, help: "A source that wanders through the tank on a Lissajous path." },
      { kind: "slider", key: "ecstasy", label: "Ecstatic pleasure", min: 0, max: 1, step: 0.01, help: "A global standing-wave drive across the whole tank, near resonance. Pushes the whole stack towards one collective mode." },
    ],
  },
  {
    title: "Source #2: psychedelic context alignment",
    specs: [
      { kind: "slider", key: "psychedelic", label: "Psychedelic dose", min: 0, max: 1, step: 0.01, help: "Models the Nature finding that psychedelics align brain activity with the current context. Priors loosen (less stabilisation), coupling between layers grows, and every layer is pulled toward the context field. Watch the alignment index." },
      {
        kind: "select",
        key: "context",
        label: "Context field",
        options: [
          { value: "rest", text: "Rest" },
          { value: "meditation", text: "Guided meditation" },
          { value: "music", text: "Music" },
          { value: "movie", text: "Movie" },
        ],
        help: "The external situation the layers can align to: rest, a slow radial meditation wave, rhythmic standing waves for music, or moving blobs for a film.",
      },
    ],
  },
  {
    title: "Source #1: Dust",
    specs: [
      { kind: "slider", key: "dust", label: "Dust (from the Director, L10)", min: 0, max: 1, step: 0.01, help: "Ubiquitous elementary consciousness: tiny random excitations injected into layer 10 only. They reach the lower layers solely through top-down coupling, so raise the top-down slider to let Dust trickle down." },
    ],
  },
  {
    title: "Matrix: Maslow and OSI+ mapping",
    specs: [
      {
        kind: "select",
        key: "matrixView",
        label: "Matrix shows",
        options: [
          { value: "activity", text: "Activity (OSI+ to Maslow)" },
          { value: "need", text: "Unmet need (Maslow to OSI+)" },
          { value: "weights", text: "Mapping weights" },
        ],
        help: "Activity: how much each layer contributes to each level (vitality x stability). Unmet need: how much each level still wants from each layer. Weights: the editable mapping itself. Click a cell to cycle its weight.",
      },
      { kind: "slider", key: "reverseGain", label: "Maslow to OSI+ drive", min: 0, max: 1, step: 0.01, help: "Reverse mapping: unmet needs of a Maslow level excite the quiet layers mapped to it (motivation). 0 switches the feedback off, leaving only OSI+ to Maslow." },
    ],
  },
  {
    title: "Wave-tank monitor (FM audification)",
    specs: [
      {
        kind: "select",
        key: "listen",
        label: "Listen to",
        options: [
          { value: "all", text: "All ten layers" },
          { value: "solo", text: "Selected layer only" },
        ],
        help: "Each layer is an FM voice driven by measurements of its wave field: pitch = measured frequency, level = amplitude, brightness = peakiness, harmonicity = phase lock with neighbours. Solo isolates the selected tank.",
      },
      { kind: "slider", key: "fmDepth", label: "FM depth", min: 0, max: 1, step: 0.01, help: "Scales the FM modulation index. Higher values make turbulent, peaky fields sound metallic and bright; zero gives plain sine tones." },
      { kind: "slider", key: "spikeSens", label: "Spike sensitivity", min: 0, max: 1, step: 0.01, help: "How big a sudden jump in a layer's wave velocity must be to count as a spike. Spikes flash the monitor LEDs and fire a bright FM pluck." },
      { kind: "slider", key: "volume", label: "Volume", min: 0, max: 1, step: 0.01, help: "Master volume. Use the Sound button in the toolbar (or S) to switch audio on; browsers need a click first." },
    ],
  },
];

let popup: HTMLDivElement | null = null;

export function showHelp(anchor: HTMLElement, title: string, text: string): void {
  hideHelp();
  const el = document.createElement("div");
  el.className = "popup";
  el.setAttribute("role", "dialog");
  const h = document.createElement("strong");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  const close = document.createElement("button");
  close.textContent = "Close";
  close.className = "btn small";
  close.addEventListener("click", hideHelp);
  el.append(h, p, close);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(window.innerWidth - el.offsetWidth - 12, Math.max(8, r.left));
  const top = r.bottom + 6 + el.offsetHeight > window.innerHeight ? Math.max(8, r.top - el.offsetHeight - 6) : r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  popup = el;
}

export function hideHelp(): void {
  popup?.remove();
  popup = null;
}

export function helpButton(title: string, text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "help";
  b.type = "button";
  b.textContent = "?";
  b.title = `Help: ${title}`;
  b.setAttribute("aria-label", `Help: ${title}`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    showHelp(b, title, text);
  });
  return b;
}

export interface Controls {
  syncAll(): void;
}

export function buildControls(root: HTMLElement, params: Params, onDimension: (d: Dimension) => void): Controls {
  const syncs: (() => void)[] = [];
  for (const group of GROUPS) {
    const section = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = group.title;
    section.append(h);
    for (const spec of group.specs) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = spec.label;
      label.append(name);
      if (spec.kind === "slider") {
        const val = document.createElement("output");
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        const sync = (): void => {
          input.value = String(params[spec.key]);
          val.textContent = Number(params[spec.key]).toFixed(spec.step < 0.01 ? 3 : 2);
        };
        input.addEventListener("input", () => {
          params[spec.key] = Number(input.value);
          val.textContent = Number(input.value).toFixed(spec.step < 0.01 ? 3 : 2);
        });
        syncs.push(sync);
        sync();
        label.append(val);
        row.append(label, input, helpButton(spec.label, spec.help));
      } else {
        const select = document.createElement("select");
        for (const o of spec.options) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.text;
          select.append(opt);
        }
        const sync = (): void => {
          select.value = String(params[spec.key]);
        };
        select.addEventListener("change", () => {
          if (spec.key === "dimension") {
            const d = Number(select.value) as Dimension;
            params.dimension = d;
            onDimension(d);
          } else if (spec.key === "context") {
            params.context = select.value as ContextMode;
          } else if (spec.key === "listen") {
            params.listen = select.value as ListenMode;
          } else {
            params.matrixView = select.value as MatrixView;
          }
        });
        syncs.push(sync);
        sync();
        row.append(label, select, helpButton(spec.label, spec.help));
      }
      section.append(row);
    }
    root.append(section);
  }
  return { syncAll: () => syncs.forEach((s) => s()) };
}
