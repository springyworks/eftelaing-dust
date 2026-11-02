import { WaveMonitor, binauralCues } from "./audio";
import { MaslowDiagram, MatrixDiagram, OsiDiagram, type MatrixClick } from "./diagrams";
import { DEFAULT_PARAMS, LAYERS, NUM_LAYERS, PRESENTATION_KEYS, SCENARIOS, defaultMapping, type Dimension, type Params, type Scenario } from "./model";
import { Exerciser } from "./exerciser";
import { queueNote, setSnapshot } from "./feedback";
import { proveLearning } from "./proof";
import { Scope, TankView } from "./render";
import { buildQuickChat } from "./quickchat";
import { startRemote } from "./remote";
import { buildVoicePanel } from "./voicepanel";
import { Stack3D } from "./stack3d";
import { Simulation, type MemoryMode, type Vec3 } from "./sim";
import { buildControls, helpButton, hideHelp, showHelp } from "./ui";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

const params: Params = { ...DEFAULT_PARAMS };
const sim = new Simulation(params.dimension);
const audio = new WaveMonitor();
let selected = 8;

const osi = new OsiDiagram($("osi"), (l) => select(l));
const maslow = new MaslowDiagram($("maslow"));
const matrix = new MatrixDiagram($("matrix"), onMatrixClick);

function onMatrixClick(c: MatrixClick): void {
  if (c.kind === "col") {
    select(c.l);
    fire(c.l);
  } else if (c.kind === "row") {
    sim.fireLevel(c.m);
    for (let l = 0; l < NUM_LAYERS; l++) if ((sim.mapping[c.m * NUM_LAYERS + l] ?? 0) > 0) audio.ping(l);
  } else {
    const i = c.m * NUM_LAYERS + c.l;
    const w = sim.mapping[i] ?? 0;
    sim.mapping[i] = w === 0 ? 0.5 : w < 1 ? 1 : 0;
  }
  matrix.update(sim, params.matrixView, selected);
}

// Spike monitor LEDs
const ledsRoot = $("leds");
const leds: { dot: HTMLElement; hz: HTMLElement; cnt: HTMLElement }[] = [];
for (let i = NUM_LAYERS - 1; i >= 0; i--) {
  const info = LAYERS[i];
  if (!info) continue;
  const el = document.createElement("div");
  el.className = "led";
  el.style.borderColor = info.color;
  const dot = document.createElement("i");
  const name = document.createElement("b");
  name.textContent = `L${info.id}`;
  const hz = document.createElement("span");
  const cnt = document.createElement("div");
  el.append(name, dot, hz, cnt);
  ledsRoot.append(el);
  leds[i] = { dot, hz, cnt };
}
const spectrum = $("spectrum") as HTMLCanvasElement;
const sceneCanvas = $("scene") as HTMLCanvasElement;
const resetMap = document.createElement("button");
resetMap.className = "btn";
resetMap.textContent = "Reset mapping";
resetMap.addEventListener("click", () => {
  sim.mapping.set(defaultMapping());
  matrix.update(sim, params.matrixView, selected);
});
$("matrix-tools").append(resetMap);

// Tanks
const thumbsRoot = $("thumbs");
const bigCanvas = $("big") as HTMLCanvasElement;
let currentBig = new TankView(bigCanvas, selected, LAYERS[selected]?.color ?? "#fff", true);
const thumbs: { view: TankView; box: HTMLElement }[] = [];

for (let i = NUM_LAYERS - 1; i >= 0; i--) {
  const info = LAYERS[i];
  if (!info) continue;
  const box = document.createElement("div");
  box.className = "thumb";
  const canvas = document.createElement("canvas");
  const caption = document.createElement("div");
  caption.textContent = `L${info.id} ${info.name}`;
  box.append(canvas, caption);
  box.addEventListener("click", () => {
    // A tap on the picture also pokes that layer at the tapped spot (see attachScratch); a drag scratches it instead.
    if (performance.now() - lastScratch > 80) select(i);
  });
  thumbsRoot.append(box);
  const view = new TankView(canvas, i, info.color, false);
  thumbs.push({ view, box });
  attachScratch(canvas, () => view, true);
}

const legend = $("legend");
for (const l of LAYERS) {
  const s = document.createElement("span");
  const sw = document.createElement("i");
  sw.style.background = l.color;
  s.append(sw, `L${l.id}`);
  legend.append(s);
}
const scope = new Scope($("scope") as HTMLCanvasElement, LAYERS.map((l) => l.color));

function configureTanks(): void {
  currentBig.configure(sim);
  thumbs.forEach((t) => t.view.configure(sim));
}

function select(layer: number): void {
  selected = layer;
  const info = LAYERS[layer];
  if (!info) return;
  currentBig = new TankView(bigCanvas, layer, info.color, true);
  currentBig.configure(sim);
  $("big-title").textContent = `Ripple tank: L${info.id} ${info.name}`;
  osi.setSelected(layer);
  thumbs.forEach((t) => t.box.classList.toggle("sel", t.view.layer === layer));
}

function fire(layer: number, pos?: Vec3): void {
  sim.fire(layer, pos);
  audio.ping(layer);
}

// Finger in the water: dragging on any tank draws a trail of ripples into that layer; a plain tap on the big tank still drops one pulse.
let lastScratch = 0;
function attachScratch(canvas: HTMLCanvasElement, view: () => TankView, big: boolean): void {
  let last: Vec3 | null = null;
  let travel = 0;
  const pos = (e: PointerEvent): Vec3 => {
    const r = canvas.getBoundingClientRect();
    return view().pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, params.projection);
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = pos(e);
    travel = 0;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = pos(e);
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
    travel += dist;
    if (travel < 0.02) return;
    const steps = Math.max(1, Math.ceil((dist * sim.nx) / 0.7));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      sim.scratch(view().layer, [last[0] + (p[0] - last[0]) * f, last[1] + (p[1] - last[1]) * f, 0.5], 0.1);
    }
    const r = canvas.getBoundingClientRect();
    audio.scratch(view().layer, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, Math.min(1, dist * 8));
    last = p;
  });
  const end = (e: PointerEvent): void => {
    if (!last) return;
    const tap = travel < 0.02;
    last = null;
    if (!tap) lastScratch = performance.now();
    else if (big && e.type === "pointerup") fire(view().layer, pos(e));
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

attachScratch(bigCanvas, () => currentBig, true);

// Controls
function onDimension(d: Dimension): void {
  sim.setDimension(d);
  configureTanks();
}

const controls = buildControls($("controls"), params, onDimension);
setSnapshot(() => ({
  params: { ...params },
  selectedLayer: selected + 1,
  chord: audio.chord,
  bpm: audio.band ? Math.round(audio.band.bpm) : null,
  instruments: audio.band?.patchInfo ?? "",
  theme: audio.band?.themeInfo ?? "",
  style: audio.band?.styleInfo ?? "",
  phrase: audio.band?.phraseInfo ?? "",
  personality: audio.band?.personalityInfo ?? "",
  alignment: Number(sim.alignment.toFixed(3)),
  rms: Array.from(sim.rms, (v) => Number(v.toFixed(3))),
  stability: Array.from(sim.stability, (v) => Number(v.toFixed(3))),
  soundOn: audio.enabled,
  voice: voicePanel.info(),
  learning: { memory: sim.memory, dopa: Number(sim.dopa.toFixed(2)), rewards: sim.rewards, links: Array.from({ length: NUM_LAYERS - 1 }, (_, l) => Number(sim.learned(l).toFixed(2))) },
}));
const toast = document.createElement("div");
toast.style.cssText = "position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:200;background:#1b2434;border:1px solid #5b8def;border-radius:8px;padding:6px 14px;font-size:13px;color:#dbe6ff;opacity:0;transition:opacity .4s;pointer-events:none";
document.body.append(toast);
let toastTimer = 0;
startRemote(params, {
  snapshot: () => ({ style: audio.band?.styleInfo ?? "", phrase: audio.band?.phraseInfo ?? "", chord: audio.chord, instruments: audio.band?.patchInfo ?? "", personality: audio.band?.personalityInfo ?? "", soundOn: audio.enabled, voice: voicePanel.info(), learning: { memory: sim.memory, dopa: Number(sim.dopa.toFixed(2)), rewards: sim.rewards } }),
  applied: () => controls.syncAll(),
  say: (text) => {
    toast.textContent = text;
    toast.style.opacity = "1";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.style.opacity = "0"), 5000);
  },
});
const exerciser = new Exerciser($("exerciser"), params, () => controls.syncAll());
exerciser.setMixHook(() => audio.band?.dominant() ?? null);
exerciser.setTeachHook((r, h) => audio.band?.teach(r, h));
$("exerciser-help").append(
  helpButton("Monte Carlo exerciser", "Let the machine play the sliders for you. It glides to a new random-ish setting, you listen and watch, and a popup asks Boring, No, Maybe or Yes (keys B, N, M, Y); tap any of the chips first (grouped as Dynamics, Voices, Space, Rhythm, Tempo, Form and Harmony: too flat or wild, dull or harsh, a voice dominates or is lost, bass thin or boomy, too washy or dry, stiff or messy, too mechanical or sloppy, no groove, too busy or sparse, drags or rushed, too little variation or no hook, jarring instrument change, melody lost, want more layers, too tense or too plain harmony) to steer the next proposal. The chips move band sliders of the brain: variation, human feel, instrument changes, harmonic colour and the voice levels (the loudest or the quietest voice is found from the live mix). Sound switches on when you start, with optional stronger answers Hellish (L) and Heavenly (H) for the truly awful and the truly beautiful. A Gaussian-process model learns from every answer which regions of the slider space you like, and proposes more of those. Move any slider yourself while it runs and the exerciser obeys at once, then slowly forgets your move (Respect my moves). Lock sliders you want to keep by clicking their row in the taste profile. Your ratings are kept in this browser."),
);
$("scene-help").append(
  helpButton("Auditory scene", "Where the ten layers sit around your head (left: seen from above, nose up; right: from the side). A tank's layer number sets its base direction and height, and the energy centre of its waves moves the voice. Poorly phase-locked layers sound farther away. With binaural HRTF on and headphones, you hear this scene. The bars show the left and right output level."),
);

const scenarioRoot = $("scenarios");
function applyScenario(s: Scenario): void {
  // How you see and hear the instrument (volume, projection, spatial sound, jazz) is yours, not the scenario's.
  const mine: Partial<Params> = {};
  for (const k of PRESENTATION_KEYS) Object.assign(mine, { [k]: params[k] });
  Object.assign(params, DEFAULT_PARAMS, mine, s.params);
  if (params.dimension !== sim.dim) sim.setDimension(params.dimension);
  else sim.reset();
  configureTanks();
  controls.syncAll();
  syncToolbar();
  if (s.fireLayer !== undefined) {
    fire(s.fireLayer);
    select(s.fireLayer);
  }
}
for (const s of SCENARIOS) {
  const wrap = document.createElement("div");
  wrap.className = "scn";
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = s.title;
  b.addEventListener("click", () => applyScenario(s));
  wrap.append(b, helpButton(s.title, s.help));
  scenarioRoot.append(wrap);
}

// Toolbar
const toolbar = $("toolbar");
function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
const playBtn = button("Pause", "", () => togglePlay());
const stepBtn = button("Step", "", () => {
  params.running = false;
  stepFrame(1);
  syncToolbar();
});
const resetBtn = button("Reset", "", () => {
  sim.reset();
});
const fireBtn = button("FIRE", "fire", () => fire(selected));
const soundBtn = button("Sound: off", "", () => void toggleSound());
const helpBtn = button("Help", "", () => showHelp(helpBtn, "How to use", GENERAL_HELP));

const GENERAL_HELP =
  "Ten wave tanks stack from L1 (Physical) to L10 (Director). Each tank is coupled to its neighbours: bottom-up the instrument sounds into the player, top-down the director conducts. " +
  "Lower layers stabilise the layer above; a loud, unstable layer weakens everything over it. Maslow's levels are fed by pairs of layers and fill when those layers are healthy and stabilised. " +
  "Fire a pulse with FIRE or by tapping the big tank (drag to scratch ripples into any tank), try a scenario, and play with the sliders. Every control has a ? button. Sound: the brain plays a jazz band, layer 1 as rhythm section, the others as a choir (every voice has its own HRTF place in the binaural scene); the raw FM sound of all layers is under General audio settings.";

const mcBtn = button("Monte Carlo: Start", "mc", () => exerciser.toggle());
const askBtn = button("Ask me now", "", () => exerciser.askNow());
exerciser.onState = (running) => {
  mcBtn.textContent = running ? "Monte Carlo: Stop" : "Monte Carlo: Start";
  mcBtn.classList.toggle("on", running);
  if (running && !audio.enabled) void toggleSound();
};
// Sugar and encouragement: "Nice" rewards what plays now, "Try again" is never punishment. Clicks in quick succession stack.
let streak = 0;
let streakAt = 0;
const rewardNote = document.createElement("span");
rewardNote.className = "reward-note";
rewardNote.textContent = "Teach the brain: click Nice as often as you like when it sounds good, Try again when it does not.";
function encourage(nice: boolean, btn: HTMLButtonElement): void {
  const now = performance.now();
  streak = now - streakAt < 4000 ? Math.min(streak + 1, 6) : 1;
  streakAt = now;
  const amount = 1 + (streak - 1) * 0.4;
  audio.band?.encourage(nice, amount);
  exerciser.cheer(nice);
  // The hormone shot: gates plasticity of the wiring between the layers, focused on the tank being watched.
  sim.reward(nice ? amount : -amount, selected);
  queueNote(`[reward] ${nice ? "Nice" : "Try again"} x${streak} on L${selected + 1}: ${audio.band?.personalityInfo ?? "sound off"}`, { rating: nice ? "nice" : "tryagain" });
  const box = thumbs[selected]?.box;
  box?.classList.add("tank-glow");
  window.setTimeout(() => box?.classList.remove("tank-glow"), 600);
  btn.classList.add("glow");
  window.setTimeout(() => btn.classList.remove("glow"), 220);
  const cheers = ["Nice!", "Lovely!", "Yes, keep going!", "Beautiful!", "Heavenly!", "More of that!"];
  rewardNote.textContent = nice
    ? `${cheers[Math.min(streak, cheers.length) - 1]} ${streak > 1 ? `(x${streak} sugar) ` : ""}${audio.band?.personalityInfo ?? "Turn the sound on and the brain will learn."}`
    : `No worries, we try again. ${audio.band?.personalityInfo ?? "Turn the sound on and the brain will learn."}`;
}
const niceBtn: HTMLButtonElement = button("Nice", "reward nice", () => encourage(true, niceBtn));
const againBtn: HTMLButtonElement = button("Try again", "reward again", () => encourage(false, againBtn));
niceBtn.title = "Reward: this sounds good. Injects a hormone shot that strengthens the wiring between recently coherent layers. Click several times for more sugar.";
againBtn.title = "Not quite: no punishment. Injects a negative shot that unlearns a little and rolls the wiring part-way back, then the brain tries something else.";
const quickChat = buildQuickChat({
  hints: (ids) => {
    exerciser.hintNow(ids);
    rewardNote.textContent = "Noted: the keywords steer the band, the message waits for the assistant.";
  },
  praise: () => encourage(true, niceBtn),
});
toolbar.append(niceBtn, againBtn, quickChat, rewardNote, playBtn, stepBtn, resetBtn, fireBtn, mcBtn, askBtn, soundBtn, helpBtn);

$("tank-tools").append(
  button("Level the sand", "small", () => sim.flattenSand()),
  button("Seed random dunes", "small", () => sim.seedSand()),
  helpButton("Sand tools", "Level the sand: every tank's sand is spread flat again (same amount of sand). Seed random dunes: the same sand is redistributed into random hills and hollows, so you can watch erosion and levelling work on it. Sand is never created or destroyed."),
);

// Typing into layer 1: each character is a pulse in the bottom tank (its place and strength come from the character), the band
// plays it as a note and the brain answers a few slots later; the raw FM voice of layer 1 plucks as well.
const typeIn = $("typein") as HTMLInputElement;
function typeInto(code: number): void {
  const x = ((code * 37) % 97) / 97;
  const y = ((code * 53) % 89) / 89;
  const amp = code >= 65 && code <= 90 ? 1.1 : code === 32 ? 0.4 : 0.8;
  sim.fire(0, [0.1 + 0.8 * x, 0.1 + 0.8 * y, 0.5], amp);
  audio.typeChar(code);
}
typeIn.addEventListener("focus", () => {
  if (selected !== 0) select(0);
  if (!audio.enabled) void toggleSound();
});
typeIn.addEventListener("input", (e) => {
  const data = (e as InputEvent).data;
  if (data) for (const ch of data) typeInto(ch.charCodeAt(0));
});
typeIn.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  typeInto(10);
  typeIn.value = "";
});
$("type-help").append(helpButton("Type into layer 1", "Every character you type is a pulse in the Physical tank (layer 1), at a place and strength set by the character. The band plays it at once as a note of the current scale (the same letter is always the same degree) in the lead instrument; three slots later the brain answers: the loudest layer sings a note back, and the keys follow with a stab. Raw FM mode plucks layer 1's own voice instead. In every audio mode you can still hear the internal MIDI doings and the raw layer FM. Enter clears the field."));

const voicePanel = buildVoicePanel($("voicebox"), {
  strike: (x, y, amp) => sim.fire(0, [x, y, 0.5], amp),
  note: (midi, vel, monitor) => audio.voiceNote(midi, vel, monitor),
  hit: (vel, bright) => audio.voiceHit(vel, bright),
  bpm: () => audio.band?.bpm ?? params.tempo,
  started: () => {
    if (!audio.enabled) void toggleSound();
  },
  setTempo: (bpm) => {
    params.tempo = Math.round(Math.min(160, Math.max(60, params.tempo + 0.4 * (bpm - params.tempo))));
    controls.syncAll();
  },
});

function syncToolbar(): void {
  playBtn.textContent = params.running ? "Pause" : "Play";
  playBtn.classList.toggle("on", !params.running);
}
function togglePlay(): void {
  params.running = !params.running;
  syncToolbar();
}
async function toggleSound(): Promise<void> {
  const on = await audio.toggle();
  soundBtn.textContent = on ? "Sound: on" : "Sound: off";
  soundBtn.classList.toggle("on", on);
}

$("osi-help").append(
  helpButton("OSI-layer plus", "Seven classic OSI layers form the instrument. L8 Player, L9 Consciousness and L10 Director sit on top. Box brightness shows wave amplitude, the connector thickness and colour show how phase-locked neighbouring layers are. Click a layer to inspect its ripple tank."),
);
$("maslow-help").append(
  helpButton("Maslow pyramid", "Six levels, each fed by one or two OSI+ layers. Fulfilment is how close those layers are to a healthy amplitude, multiplied by the stability they receive from below. Higher levels fade when lower ones are unmet."),
);
$("matrix-help").append(
  helpButton("Maslow x OSI+ matrix", "Rows are Maslow levels, columns are OSI+ layers. Cells show how much a layer contributes to a level (activity, OSI+ to Maslow) or how much a level still needs from a layer (unmet need, Maslow to OSI+); the third view shows the editable weights. Click a cell to cycle its weight 0, 0.5, 1; click a column header to strike that layer; click a row header to strike every layer mapped to that level. Reverse drive is set with the Maslow to OSI+ slider."),
);
$("monitor-help").append(
  helpButton("Wave-tank monitor", "Every layer is an FM voice driven by measurements of its tank: pitch = measured frequency, loudness = amplitude, brightness = peakiness, harmonic ratio = phase lock with neighbours. A sudden velocity jump is a spike: the LED flashes and a bright pluck sounds. The number under each LED counts spikes. The graph is the live spectrum. The pitch scale is a fixed time-scaling, so it shows relative, not physical, frequencies."),
);
$("tank-help").append(helpButton("Ripple tank", "The wave medium of the selected layer (red-ish and blue-ish tones are positive and negative displacement). Tap to drop a pulse, or drag your finger (mouse) through the water to scratch ripples into it, as in Falstad's ripple tank; the drag works in every projection. In 1D it is drawn as a string; in 3D the middle slice is shown."));
$("thumbs-help").append(helpButton("All ten tanks", "Click a thumbnail to select that layer, or drag across one to scratch ripples straight into that layer. Watch waves cross from tank to tank through the coupling sliders."));
$("scope-help").append(helpButton("Amplitude scope", "RMS amplitude of every layer over the last few seconds, in layer colours. Instabilities and cascades show up here before they are visible in the pyramid."));

// Main loop
let accumulator = 0;
let frame = 0;
let lastStatus = performance.now();
let stepsSinceStatus = 0;

function stepFrame(n: number): void {
  for (let i = 0; i < n; i++) sim.step(params);
  stepsSinceStatus += n;
}

let lastFrame = performance.now();
let lastObserve = lastFrame;

// The learned wiring survives a reload: the memory mode, the per-link gains and the sand beds (the sand memory).
const WIRING_KEY = "eftelaing-dust.tanks.v2";
try {
  const saved = JSON.parse(localStorage.getItem(WIRING_KEY) ?? "null") as { mode?: unknown; gain?: unknown; sand?: unknown } | null;
  if (saved && typeof saved === "object") {
    if (saved.mode === "gain" || saved.mode === "sand" || saved.mode === "both") sim.setMemory(saved.mode);
    if (Array.isArray(saved.gain)) saved.gain.forEach((v: unknown, i: number) => { if (typeof v === "number" && i < sim.gain.length) sim.gain[i] = Math.min(2, Math.max(0.5, v)); });
    if (typeof saved.sand === "string") sim.importSand(saved.sand);
  }
} catch { /* no saved wiring */ }
let wiringSavedAt = lastFrame;
function saveWiring(nowMs: number): void {
  if (nowMs - wiringSavedAt < 20000) return;
  wiringSavedAt = nowMs;
  try { localStorage.setItem(WIRING_KEY, JSON.stringify({ mode: sim.memory, gain: Array.from(sim.gain), sand: sim.memory === "gain" ? "" : sim.exportSand() })); } catch { /* storage full or blocked */ }
}

// Learning card: reward hormone level, the nine learned couplings (dashed line = innate 1.0), the sand coupling map and an A/B proof experiment.
const learnRoot = $("learn");
const memSelect = document.createElement("select");
for (const [v, t] of [["sand", "Memory in the sand beds"], ["gain", "Memory in link gains"], ["both", "Sand beds and link gains"]] as const) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  memSelect.append(o);
}
memSelect.value = sim.memory;
memSelect.addEventListener("change", () => sim.setMemory(memSelect.value as MemoryMode));
const dopaBar = document.createElement("div");
dopaBar.className = "dopa";
const dopaFill = document.createElement("div");
dopaFill.className = "bar";
dopaBar.append(dopaFill);
const gainRow = document.createElement("div");
gainRow.className = "learn-row";
const gainBars: HTMLElement[] = [];
for (let l = 0; l < NUM_LAYERS - 1; l++) {
  const col = document.createElement("div");
  col.className = "learn-col";
  col.title = `Coupling between L${l + 1} and L${l + 2}`;
  const mid = document.createElement("div");
  mid.className = "mid";
  mid.style.bottom = "50%";
  const bar = document.createElement("div");
  bar.className = "bar";
  const lab = document.createElement("span");
  lab.textContent = `${l + 1}-${l + 2}`;
  col.append(bar, mid, lab);
  gainBars.push(bar);
  gainRow.append(col);
}
const mapCanvas = document.createElement("canvas");
mapCanvas.className = "cpl-map";
mapCanvas.title = "Coupling carved in the sand between the selected layer and the one above it: bright = strongly coupled there, dark = closed.";
const mapCtx = mapCanvas.getContext("2d");
const learnOut = document.createElement("div");
learnOut.className = "learn-out";
learnOut.textContent = "Click Nice or Try again and watch the hormone, the couplings and the sand map move. Prove it runs a control against a rewarded copy.";
let proving = false;
const proveBtn = button("Prove it (A/B experiment)", "small", () => {
  if (proving) return;
  proving = true;
  proveBtn.disabled = true;
  void proveLearning(params, 1, (t) => { learnOut.textContent = t; }, sim.memory)
    .then((r) => {
      const gain = (r.trained.lock / Math.max(1e-6, r.control.lock) - 1) * 100;
      learnOut.innerHTML =
        `Phase lock between layers: <b>${r.control.lock.toFixed(3)}</b> without reward, <b>${r.trained.lock.toFixed(3)}</b> after 8 Nice shots on L9 (${gain >= 0 ? "+" : ""}${gain.toFixed(0)}%). ` +
        `Coupling where the layers cooperate: ${r.control.gain.toFixed(2)} to ${r.trained.gain.toFixed(2)} (${sim.memory}).`;
    })
    .catch((e: unknown) => { learnOut.textContent = `Experiment failed: ${String(e)}`; })
    .finally(() => { proving = false; proveBtn.disabled = false; });
});
const forgetBtn = button("Forget learned wiring", "small", () => {
  sim.forgetWiring();
  learnOut.textContent = "The wiring is back to its innate state and the sand is level again.";
});
const learnBtns = document.createElement("div");
learnBtns.className = "learn-btns";
learnBtns.append(memSelect, proveBtn, forgetBtn);
const learnBody = document.createElement("div");
learnBody.className = "learn-body";
learnBody.append(gainRow, mapCanvas);
learnRoot.append(dopaBar, learnBody, learnBtns, learnOut);
$("learn-help").append(
  helpButton(
    "Reward hormone and sand memory",
    "Nice injects a shot of a reward hormone (dopamine) that decays in about 6 seconds; Try again injects a negative one. Where the learning lives is your choice. Sand beds (default): between two layers the coupling at each spot is carved by the sand of both beds (dunes open the link, hollows close it; the stack is a 3D medium whose vertical conductivity is made of sand). Positive hormone makes the sand of a layer climb towards spots where it has recently been in phase with its neighbours (negative hormone moves it away, and slides the beds part-way back to ~12 s ago). Sand is only redistributed, never created or destroyed, and the usual levelling slowly forgets. No back-propagation, only waves, sand and a hormone. Link gains: one learned number per link (three-factor rule). The bars show the coupling where the layers cooperate (dashed = innate); the picture is the coupling map of the selected link. The band reads the layer phase locks, so the learned wiring changes the music. Nice also teaches the band's taste and the Monte Carlo model. Prove it runs a control simulation against a copy that gets eight Nice shots on L9 and compares the phase lock.",
  ),
);
const stack = new Stack3D($("stack3d") as HTMLCanvasElement, (layer, pos) => {
  select(layer);
  fire(layer, pos);
});
$("st-iso").addEventListener("click", () => stack.setView(0.6, 0.75));
$("st-side").addEventListener("click", () => stack.setView(0.6, 0.12));
$("st-top").addEventListener("click", () => stack.setView(0, 1.5));
$("stack-help").append(
  helpButton(
    "3D stack",
    "The ten layers as plates in a stack, bottom layer (L1, Physical) at the bottom and the Director (L10) on top. Plate image: the wave field of that layer (brightness = displacement; in 3D tanks the middle slice). Plate rim: thickness = the layer's amplitude, white = the selected layer. Vertical lines: the link between two layers at a sample of spots; width and brightness = the coupling carved by the sand memory there (1 = innate) times how in-phase the two layers have recently been at that spot, so rewarded cooperation lights up. Moving dots run along a link from the louder layer to the quieter one, faster the bigger the difference. Nothing is decoration. Drag to orbit, wheel to zoom, tap a plate to select it and tickle it at that spot (you hear it). It is a canvas-2D orthographic projection, not WebGL.",
  ),
);

function drawLearning(): void {
  const d = sim.dopa;
  dopaFill.style.background = d >= 0 ? "#ffd56a" : "#6aa8ff";
  dopaFill.style.left = d >= 0 ? "50%" : `${50 + (d / 2.5) * 50}%`;
  dopaFill.style.width = `${(Math.abs(d) / (d >= 0 ? 4 : 2.5)) * 50}%`;
  gainBars.forEach((b, l) => { b.style.height = `${(Math.min(2, sim.learned(l)) / 2) * 100}%`; });
  const map = sim.couplingMap(Math.min(selected, NUM_LAYERS - 2));
  if (mapCtx && map && sim.memory !== "gain") {
    if (mapCanvas.width !== sim.nx || mapCanvas.height !== sim.ny) {
      mapCanvas.width = sim.nx;
      mapCanvas.height = sim.ny;
    }
    const img = mapCtx.createImageData(sim.nx, sim.ny);
    for (let i = 0; i < sim.nx * sim.ny; i++) {
      const v = Math.round(Math.min(1, Math.max(0, ((map[i] ?? 1) - 0.3) / 2.2)) * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = Math.round(v * 0.85);
      img.data[i * 4 + 2] = Math.round(60 + v * 0.3);
      img.data[i * 4 + 3] = 255;
    }
    mapCtx.putImageData(img, 0, 0);
    mapCanvas.style.visibility = "visible";
  } else mapCanvas.style.visibility = "hidden";
}

function tick(): void {
  const nowMs = performance.now();
  exerciser.update(Math.min(0.1, (nowMs - lastFrame) / 1000));
  voicePanel.update(Math.min(0.1, (nowMs - lastFrame) / 1000));
  lastFrame = nowMs;
  if (params.running) {
    accumulator += params.speed;
    const n = Math.floor(accumulator);
    accumulator -= n;
    stepFrame(n);
  }
  frame++;
  if (frame % 2 === 0) {
    sim.observe(params, Math.min(0.2, (nowMs - lastObserve) / 1000));
    lastObserve = nowMs;
    saveWiring(nowMs);
    scope.push(sim.rms);
    scope.draw();
    audio.update(sim, params, selected);
    for (let l = 0; l < NUM_LAYERS; l++) if ((sim.spikes[l] ?? 0) > 0) leds[l]?.dot.classList.add("on");
  }
  const gain = 2.2;
  currentBig.draw(sim, gain, params.projection);
  thumbs.forEach((t) => t.view.draw(sim, gain, params.projection));
  if (frame % 2 === 0) stack.draw(sim, selected, nowMs / 1000);
  if (frame % 6 === 0) {
    drawLearning();
    osi.update(sim);
    maslow.update(sim);
    matrix.update(sim, params.matrixView, selected);
    leds.forEach((led, l) => {
      led.dot.classList.remove("on");
      led.hz.textContent = `${(audio.pitchHz[l] ?? 0).toFixed(0)}Hz`;
      led.cnt.textContent = `${sim.spikeCount[l] ?? 0}`;
    });
    audio.spectrum(spectrum);
    audio.drawScene(sceneCanvas, selected);
    const sv = audio.scene[selected];
    if (sv) {
      const cues = binauralCues(sv.az, sv.el);
      $("cues").innerHTML =
        `Selected: <b>L${selected + 1}</b><br>azimuth <b>${sv.az.toFixed(0)}°</b> elevation <b>${sv.el.toFixed(0)}°</b><br>distance <b>${sv.r.toFixed(1)} m</b><br>` +
        `ITD <b>${Math.abs(cues.itdUs).toFixed(0)} µs</b> ${cues.itdUs >= 0 ? "(right ear first)" : "(left ear first)"}<br>ILD <b>${cues.ildDb.toFixed(1)} dB</b><br>pinna notch <b>${(cues.notchHz / 1000).toFixed(1)} kHz</b><br>chord <b>${audio.chord}</b><br>theme <b>${audio.band?.themeInfo ?? "-"}</b><br>style <b>${audio.band?.styleInfo ?? "-"}</b><br>phrase <b>${audio.band?.phraseInfo || "-"}</b><br>brain <b>${audio.band?.personalityInfo ?? "-"}</b><br>instruments <b>${audio.band?.patchInfo || "-"}</b>${audio.band?.echoInfo ? `<br>typing <b>${audio.band.echoInfo}</b>` : ""}<br>band <b>${audio.band ? audio.band.bpm.toFixed(0) : "-"} bpm</b>${audio.band?.midiName ? `<br>MIDI <b>${audio.band.midiName}</b>` : ""}`;
    }
    $("ro-relief").textContent = sim.sandRelief(selected).toFixed(3);
    $("ro-sand").textContent = sim.sandMass(selected).toFixed(1);
    $("ro-align").textContent = `${(sim.alignment * 100).toFixed(0)}%`;
    $("ro-amp").textContent = (sim.rms[selected] ?? 0).toFixed(3);
    $("ro-stab").textContent = `${((selected === 0 ? 1 : sim.stability[selected - 1] ?? 1) * 100).toFixed(0)}%`;
  }
  const now = performance.now();
  if (now - lastStatus > 500) {
    const sps = (stepsSinceStatus * 1000) / (now - lastStatus);
    const gpu = "gpu" in navigator ? "WebGPU available (CPU solver in use)" : "no WebGPU (CPU solver)";
    $("status").textContent = `${params.dimension}D tanks · ${sim.size} cells/layer · ${sps.toFixed(0)} steps/s · t=${sim.t} · ${gpu}`;
    lastStatus = now;
    stepsSinceStatus = 0;
  }
  requestAnimationFrame(tick);
}

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element) || !e.target.closest(".popup, .help")) hideHelp();
});
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "f" || e.key === "F") fire(selected);
  else if (e.key === "s" || e.key === "S") void toggleSound();
  else if (e.key === "Escape") hideHelp();
});

configureTanks();
select(selected);
syncToolbar();
fire(7);
fire(8);
requestAnimationFrame(tick);
