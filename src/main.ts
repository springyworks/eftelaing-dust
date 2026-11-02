import { Instrument } from "./audio";
import { MaslowDiagram, OsiDiagram } from "./diagrams";
import { DEFAULT_PARAMS, LAYERS, NUM_LAYERS, SCENARIOS, type Dimension, type Params, type Scenario } from "./model";
import { Scope, TankView } from "./render";
import { Simulation, type Vec3 } from "./sim";
import { buildControls, helpButton, hideHelp, showHelp } from "./ui";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

const params: Params = { ...DEFAULT_PARAMS };
const sim = new Simulation(params.dimension);
const audio = new Instrument();
let selected = 8;

const osi = new OsiDiagram($("osi"), (l) => select(l));
const maslow = new MaslowDiagram($("maslow"));

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
  box.addEventListener("click", () => select(i));
  thumbsRoot.append(box);
  thumbs.push({ view: new TankView(canvas, i, info.color, false), box });
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

function posFromEvent(e: MouseEvent): Vec3 {
  const r = bigCanvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, 0.5];
}

function fire(layer: number, pos?: Vec3): void {
  sim.fire(layer, pos);
  audio.ping(layer);
}

bigCanvas.addEventListener("click", (e) => fire(selected, posFromEvent(e)));

// Controls
function onDimension(d: Dimension): void {
  sim.setDimension(d);
  configureTanks();
}

const controls = buildControls($("controls"), params, onDimension);

const scenarioRoot = $("scenarios");
function applyScenario(s: Scenario): void {
  Object.assign(params, DEFAULT_PARAMS, s.params);
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
  "Fire a pulse with FIRE or by clicking the big tank, try a scenario, and play with the sliders. Every control has a ? button.";

toolbar.append(playBtn, stepBtn, resetBtn, fireBtn, soundBtn, helpBtn);

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
$("tank-help").append(helpButton("Ripple tank", "The wave medium of the selected layer (red-ish and blue-ish tones are positive and negative displacement). Click anywhere to drop a pulse. In 1D it is drawn as a string; in 3D the middle slice is shown."));
$("thumbs-help").append(helpButton("All ten tanks", "Click a thumbnail to select that layer. Watch waves cross from tank to tank through the coupling sliders."));
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

function tick(): void {
  if (params.running) {
    accumulator += params.speed;
    const n = Math.floor(accumulator);
    accumulator -= n;
    stepFrame(n);
  }
  frame++;
  if (frame % 2 === 0) {
    sim.observe(params);
    scope.push(sim.rms);
    scope.draw();
    audio.update(sim, params);
  }
  const gain = 2.2;
  currentBig.draw(sim, gain);
  thumbs.forEach((t) => t.view.draw(sim, gain));
  if (frame % 6 === 0) {
    osi.update(sim);
    maslow.update(sim);
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
