// Control panel construction with per-control help popups.

import type { AudioMode, ContextMode, MidiOut, Dimension, ListenMode, MatrixView, Params, Projection, SpatialMode } from "./model";

export type NumKey = Exclude<{ [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params], "dimension">;

export interface SliderSpec {
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
  readonly key: "dimension" | "context" | "listen" | "matrixView" | "projection" | "spatial" | "audioMode" | "midiOut";
  readonly label: string;
  readonly options: readonly { value: string; text: string }[];
  readonly help: string;
}

type Spec = SliderSpec | SelectSpec;

interface Group {
  readonly title: string;
  readonly collapsed?: boolean;
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
    title: "Sand bed: erosion and levelling",
    specs: [
      { kind: "slider", key: "sandErosion", label: "Erosion (waves move sand)", min: 0, max: 1, step: 0.01, help: "Agitated water pushes sand towards the quiet spots (nodes), the way sand gathers in Chladni figures and sea bars form on a beach. Sand is never destroyed: every grain that leaves a cell arrives in a neighbour, so the total sand mass of a tank stays constant." },
      { kind: "slider", key: "sandLevel", label: "Levelling (gravity)", min: 0, max: 1, step: 0.01, help: "Sand slides downhill and smooths the bed. Against erosion it sets the size and steepness of the ripples and dunes that can form." },
      { kind: "slider", key: "sandDepth", label: "Bed shapes the waves", min: 0, max: 1, step: 0.01, help: "Shallow water is slow. With this above 0 the height of the sand changes the local wave speed, so the tank learns its own history: patterns of sand steer later waves, which move the sand again." },
      {
        kind: "select",
        key: "projection",
        label: "Projection",
        options: [
          { value: "wave", text: "Waves only (plan)" },
          { value: "sand", text: "Sand relief (plan)" },
          { value: "both", text: "Sand + water (plan)" },
          { value: "iso", text: "Isometric 3D" },
          { value: "profile", text: "Beach profile (side)" },
        ],
        help: "How the selected tank is shown. Plan views look straight down (sand as shaded relief, water as colour). Isometric draws the tank as rows of a 3D surface, and the profile is a cross-section like a beach seen from the side. Thumbnails always use a plan view.",
      },
    ],
  },
  {
    title: "Stereo, HRTF and jazz",
    specs: [
      {
        kind: "select",
        key: "spatial",
        label: "Spatial audio",
        options: [
          { value: "binaural", text: "Binaural HRTF (headphones)" },
          { value: "stereo", text: "Plain stereo pan" },
        ],
        help: "Binaural: a parametric head model per voice (interaural time and level difference, pinna notches, distance and room) makes the ten layers sound as if they sit around you in 3D. Wear headphones. Stereo: a simple left/right pan. See knowlege_source/Hearing.md.",
      },
      { kind: "slider", key: "width", label: "Stage width", min: 0, max: 1, step: 0.01, help: "How far apart the ten layers are placed around the listener. The energy centre of each tank also moves its voice, so waves that travel across a tank are heard travelling across the stage." },
      { kind: "slider", key: "reverb", label: "Room reverb", min: 0, max: 1, step: 0.01, help: "Early reflections and a diffuse tail. Distant voices get relatively more room, which is how the ear judges distance. Also helps to externalise the sound in headphones." },
      { kind: "slider", key: "jazz", label: "Jazz harmony (pitch snap)", min: 0, max: 1, step: 0.01, help: "Pulls the raw FM voices' measured pitch towards a chord tone of the Dm11, G13, Cmaj9#11, A7b9b13 loop (two bars each). 0 = raw tank frequencies, 1 = fully in the chord. The jazz band always plays the chords; high Maslow fulfilment resolves them (Cmaj9, A13)." },
      { kind: "slider", key: "swing", label: "Swing (pluck timing)", min: 0, max: 1, step: 0.01, help: "0 = a raw FM spike sounds immediately. Above 0 the band and every pluck wait for the next slot of an eighth-note grid, with the off-beats pushed later towards triplet swing as the slider goes up." },
    ],
  },
  {
    title: "General audio settings (band, raw FM, MIDI)",
    collapsed: true,
    specs: [
      {
        kind: "select",
        key: "audioMode",
        label: "Audio mode",
        options: [
          { value: "raw", text: "1. Raw FM synthesiser (psychiatric inspection)" },
          { value: "brain", text: "2. Internal music: the whole brain plays" },
          { value: "layer1", text: "3. Layer 1 alone plays the synthesiser" },
          { value: "both", text: "Raw FM + internal music together" },
        ],
        help: "1: the original FM audification: every layer is a voice and spikes pluck it, the nervous sound for inspecting the system. 2: the whole ten-layer brain plays the jazz band (layer 1 as rhythm section, the others as choir, melody and conductor) on the MIDI-style synthesiser. 3: only layer 1 (Physical) plays the synthesiser. Every voice sits at its own HRTF position in the scene.",
      },
      { kind: "slider", key: "rawLevel", label: "Raw FM level", min: 0, max: 1.5, step: 0.01, help: "Loudness of the raw FM voices (modes 1 and Raw + music)." },
      { kind: "slider", key: "bandLevel", label: "Band level (MIDI synth master)", min: 0, max: 1.5, step: 0.01, help: "Loudness of the whole MIDI band and choir (modes 2, 3 and Raw + music)." },
      { kind: "slider", key: "bandDensity", label: "Band busyness", min: 0, max: 1, step: 0.01, help: "How many melody notes and extra comping stabs are played. 0.5 is as designed; 0 is sparse, 1 is busy." },
      { kind: "slider", key: "bandBrain", label: "Brain plays the band (L1 only → all ten)", min: 0, max: 1, step: 0.01, help: "Used in mode 2 (mode 3 forces 0). 0: only layer 1 (Physical) plays: its tank drives bass, keys, melody and ride. 1: the whole brain plays and conducts. Upper layers steer the melody (L7, L8), the comping peakiness (L4), the tempo (L10 Director) and the harmony (every Maslow level), and each of them speaks as its own instrument (see the choir). A healthy, aligned brain plays tight and in tune; a stressed one gets loose and tense." },
      { kind: "slider", key: "bandChoir", label: "Layer choir level (one voice per layer)", min: 0, max: 1, step: 0.01, help: "L2 to L10 each play chord tones on their own MIDI voice, picked from the pitch their wave tank measures, and speak up when they spike. Each voice has its own HRTF (Hearing.md): ITD, head shadow, pinna notch and room, at the position of its layer in the scene. Scaled by the brain share above." },
      { kind: "slider", key: "bandBass", label: "Bass level", min: 0, max: 1, step: 0.01, help: "How present the walking bass is. The Monte Carlo exerciser moves this too, so the brain learns what band you like." },
      { kind: "slider", key: "bandKeys", label: "Keys level", min: 0, max: 1, step: 0.01, help: "How present the comping piano is." },
      { kind: "slider", key: "bandLead", label: "Lead level", min: 0, max: 1, step: 0.01, help: "How present the melody line is." },
      { kind: "slider", key: "bandDrums", label: "Ride and hat level", min: 0, max: 1, step: 0.01, help: "How present the ride cymbal and foot hi-hat are." },
      { kind: "slider", key: "bandVariation", label: "Variation (themes develop)", min: 0, max: 1, step: 0.01, help: "How much the tune develops: passing notes, shifted phrases, extra answers, rhythm slots that join or drop out. 0 plays the layer-read theme exactly, 1 keeps reinventing it. The notes still come from the layers, this only widens how far they wander." },
      { kind: "slider", key: "bandHuman", label: "Human feel (0 machine)", min: 0, max: 1, step: 0.01, help: "0 = machine-exact timing and equal velocities (the mechanical sound). 1 = loose, laid-back and breathing: timing wanders with the wave fields, velocities swell and fade, the lead sits a little behind the beat." },
      { kind: "slider", key: "bandSwitch", label: "Instrument changes (0 never)", min: 0, max: 1, step: 0.01, help: "How often a voice may swap its instrument. The new instrument is read from the driving layer, then handed over slowly: the old one fades out while the new one fades in over two bars, one voice at a time, at phrase boundaries. 0 freezes the instruments." },
      { kind: "slider", key: "bandColor", label: "Harmonic colour (sweet → tense)", min: 0, max: 1, step: 0.01, help: "Biases the chords the brain picks from its Maslow fulfilment. 0.5 = as the brain feels it. Lower: resolved sweet chords (Cmaj9, A13). Higher: tense altered chords (Cmaj9#11, A7b9b13)." },
      { kind: "slider", key: "tempo", label: "Band tempo (bpm)", min: 60, max: 160, step: 1, help: "Base tempo of the band. A busy bottom layer pushes it up to about 6% faster, a quiet one slows it by the same amount. Swing is set in the jazz group." },
      {
        kind: "select",
        key: "midiOut",
        label: "MIDI output",
        options: [
          { value: "off", text: "Off" },
          { value: "on", text: "Send the band to the first MIDI output" },
        ],
        help: "Also sends the band as MIDI (bass channel 1, keys channel 2, lead channel 3, ride and pedal hi-hat on drum channel 10) through Web MIDI, so an external synthesiser or DAW can play it. The browser asks for permission; Sound must be on. Not available in every browser.",
      },
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
      { kind: "slider", key: "alcCeiling", label: "Level ceiling (ALC)", min: 0.3, max: 0.95, step: 0.01, help: "Automatic level control. A watcher measures the peak of everything that is about to be played and pulls the gain down at once when it would exceed this ceiling, then lets it recover slowly, like a homeostatic reflex. Behind it sit a fast limiter and a soft clipper, so the output can never clip. The ALC readout in the audio scene shows the gain reduction in dB." },
    ],
  },
];

export const SLIDERS: readonly SliderSpec[] = GROUPS.flatMap((g) => g.specs.filter((sp): sp is SliderSpec => sp.kind === "slider"));

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
    const section = document.createElement(group.collapsed ? "details" : "section");
    const h = document.createElement(group.collapsed ? "summary" : "h3");
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
          document.dispatchEvent(new CustomEvent("slider-input", { detail: spec.key }));
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
          } else if (spec.key === "projection") {
            params.projection = select.value as Projection;
          } else if (spec.key === "spatial") {
            params.spatial = select.value as SpatialMode;
          } else if (spec.key === "audioMode") {
            params.audioMode = select.value as AudioMode;
          } else if (spec.key === "midiOut") {
            params.midiOut = select.value as MidiOut;
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
