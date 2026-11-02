// Domain model: OSI+ layers, Maslow levels and the shared parameter set.

export type Group = "instrument" | "player" | "consciousness" | "director";

export interface LayerInfo {
  readonly id: number; // 1..10
  readonly name: string;
  readonly role: string;
  readonly group: Group;
  readonly color: string;
}

export const LAYERS: readonly LayerInfo[] = [
  { id: 1, name: "Physical", role: "substrate, bits on matter", group: "instrument", color: "#6b7a8f" },
  { id: 2, name: "Data Link", role: "framing, local reliability", group: "instrument", color: "#64829c" },
  { id: 3, name: "Network", role: "addressing, routing", group: "instrument", color: "#5a8bad" },
  { id: 4, name: "Transport", role: "end-to-end flow", group: "instrument", color: "#4f96b5" },
  { id: 5, name: "Session", role: "dialogue, continuity", group: "instrument", color: "#44a1b3" },
  { id: 6, name: "Presentation", role: "encoding, meaning format", group: "instrument", color: "#3aab9f" },
  { id: 7, name: "Application", role: "interface to the player", group: "instrument", color: "#3fb38a" },
  { id: 8, name: "Player", role: "agency, self-model, technique", group: "player", color: "#c9a23a" },
  { id: 9, name: "Consciousness", role: "felt experience: pain, delight, interest, curiosity, ecstasy", group: "consciousness", color: "#d9702f" },
  { id: 10, name: "Director", role: "intent, meaning, Dust (ubiquitous elementary consciousness)", group: "director", color: "#b04ad0" },
];

export const NUM_LAYERS = LAYERS.length;

export interface MaslowLevel {
  readonly name: string;
  readonly layers: readonly number[]; // 0-based layer indices
  readonly color: string;
}

// Bottom to top.
export const MASLOW: readonly MaslowLevel[] = [
  { name: "Physiological", layers: [0, 1], color: "#8a6d3b" },
  { name: "Safety", layers: [2, 3], color: "#7a8a3b" },
  { name: "Love / Belonging", layers: [4, 5], color: "#3b8a5c" },
  { name: "Esteem", layers: [6, 7], color: "#3b7a8a" },
  { name: "Self-actualisation", layers: [8], color: "#5b4fb0" },
  { name: "Self-transcendence", layers: [9], color: "#a63fa6" },
];

export const NUM_LEVELS = MASLOW.length;

// Mapping weights between Maslow levels (rows) and OSI+ layers (columns), row-major [level * NUM_LAYERS + layer].
export function defaultMapping(): Float32Array {
  const w = new Float32Array(NUM_LEVELS * NUM_LAYERS);
  MASLOW.forEach((level, m) => level.layers.forEach((l) => (w[m * NUM_LAYERS + l] = 1)));
  return w;
}

export type MatrixView = "activity" | "need" | "weights";
export type ListenMode = "all" | "solo";
export type ContextMode = "rest" | "meditation" | "music" | "movie";
export type Dimension = 1 | 2 | 3;

export interface Params {
  running: boolean;
  speed: number; // sim steps per frame
  dimension: Dimension;
  damping: number;
  stabilization: number; // 0..1, how strongly lower layers stabilise the one above
  couplingUp: number; // bottom-up
  couplingDown: number; // top-down
  instrumentDrive: number; // L1-L7 baseline hum
  playerActivity: number; // L8
  directorIntent: number; // L10
  dust: number; // ubiquitous noise in every layer
  pain: number;
  delight: number;
  interest: number;
  curiosity: number;
  ecstasy: number;
  psychedelic: number; // 5-HT2A-like context alignment
  context: ContextMode;
  volume: number;
  listen: ListenMode;
  fmDepth: number; // FM modulation index scale of the monitor
  spikeSens: number; // spike detector sensitivity
  reverseGain: number; // Maslow unmet need driving the mapped OSI layers
  matrixView: MatrixView;
}

export const DEFAULT_PARAMS: Params = {
  running: true,
  speed: 2,
  dimension: 2,
  damping: 0.012,
  stabilization: 0.5,
  couplingUp: 0.5,
  couplingDown: 0.3,
  instrumentDrive: 0.5,
  playerActivity: 0.3,
  directorIntent: 0.3,
  dust: 0.1,
  pain: 0,
  delight: 0,
  interest: 0,
  curiosity: 0,
  ecstasy: 0,
  psychedelic: 0,
  context: "rest",
  volume: 0.5,
  listen: "all",
  fmDepth: 0.6,
  spikeSens: 0.5,
  reverseGain: 0.3,
  matrixView: "activity",
};

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly help: string;
  readonly params: Partial<Params>;
  readonly fireLayer?: number; // 0-based, fired once when applied
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "baseline",
    title: "Calm baseline",
    help: "Quiet instrument, a little Dust. Every Maslow level slowly settles; use it as the reference state.",
    params: { ...DEFAULT_PARAMS, speed: 2 },
  },
  {
    id: "cascade",
    title: "Bottom-up cascade",
    help: "A single impulse at the Physical layer travels upward through coupling only (no top-down). Watch the wave front climb L1 to L10.",
    params: { ...DEFAULT_PARAMS, instrumentDrive: 0, playerActivity: 0, directorIntent: 0, dust: 0.02, reverseGain: 0, couplingUp: 0.9, couplingDown: 0, stabilization: 0.05, damping: 0.003 },
    fireLayer: 0,
  },
  {
    id: "conductor",
    title: "Director conducts",
    help: "Only the Director (L10) plays; energy flows down through Consciousness and Player into the instrument. Director, players, instrument in one gesture.",
    params: { ...DEFAULT_PARAMS, instrumentDrive: 0, playerActivity: 0, directorIntent: 1, reverseGain: 0, couplingUp: 0, couplingDown: 0.9, stabilization: 0.05, damping: 0.003, dust: 0.03 },
    fireLayer: 9,
  },
  {
    id: "pain",
    title: "Pain spike",
    help: "Sharp, localised, high-frequency bursts in L9. The noisy layer lowers the stability chain, so the layers above lose their stabilisation and Maslow's upper levels collapse.",
    params: { ...DEFAULT_PARAMS, pain: 0.9, couplingUp: 0.6, couplingDown: 0.5 },
  },
  {
    id: "flow",
    title: "Flow / delight",
    help: "Delight plus interest in a well-stabilised stack. L9 sings steadily and the pyramid fills from the bottom up.",
    params: { ...DEFAULT_PARAMS, delight: 0.7, interest: 0.5, stabilization: 0.8, playerActivity: 0.6, directorIntent: 0.5 },
  },
  {
    id: "ecstasy",
    title: "Ecstatic resonance",
    help: "A global standing-wave drive at L9's natural frequency, with strong two-way coupling. The whole stack may lock into one collective mode.",
    params: { ...DEFAULT_PARAMS, ecstasy: 0.9, couplingUp: 0.8, couplingDown: 0.8, damping: 0.006, directorIntent: 0.6 },
  },
  {
    id: "psy-music",
    title: "Psychedelic + music",
    help: "Source #2: psychedelics align brain activity with the present context. Context alignment is high, layer boundaries blur, and every layer is pulled toward the music field.",
    params: { ...DEFAULT_PARAMS, psychedelic: 0.85, context: "music", curiosity: 0.5, delight: 0.4, stabilization: 0.3, couplingUp: 0.7, couplingDown: 0.7 },
  },
  {
    id: "dust",
    title: "Dust storm",
    help: "Source #1: Dust, ubiquitous elementary consciousness, enters at the Director (L10) and trickles down through the top-down coupling. No designed drive. See what structure emerges lower in the stack.",
    params: { ...DEFAULT_PARAMS, instrumentDrive: 0, playerActivity: 0, directorIntent: 0, dust: 1, couplingUp: 0.6, couplingDown: 0.9, damping: 0.006, reverseGain: 0 },
  },
];

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
