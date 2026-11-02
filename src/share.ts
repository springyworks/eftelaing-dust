// Share link: the whole working state (sliders, learned wiring and sand, the band's personality and taste, the Monte Carlo
// taste model) is packed into the URL fragment, so a link recreates the instrument as it was. The fragment never reaches a
// server. A link is applied by writing the values to localStorage and reloading, so the normal startup code reads them.

import type { Dimension, Params } from "./model";
import { SELECTS, SLIDERS } from "./ui";

export const REPO_URL = "https://github.com/springyworks/eftelaing-dust";
export const DEMO_URL = "https://springyworks.github.io/eftelaing-dust/";

const STORE_KEYS = ["eftelaing-dust.brain.v1", "eftelaing-dust.taste.v1", "eftelaing-dust.tanks.v2"] as const;
const PARAMS_KEY = "eftelaing-dust.shared-params.v1";
const MAX_BYTES = 3_000_000;

interface Bundle {
  v: 1;
  params: Record<string, number | string>;
  store: Record<string, string>;
  layer: number;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes.slice()]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(await out);
}

/** "z" + deflate when the browser can, "r" + plain otherwise. */
export async function pack(text: string): Promise<string> {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === "function") return `z${toB64(await pipe(raw, new CompressionStream("deflate-raw")))}`;
  return `r${toB64(raw)}`;
}

export async function unpack(text: string): Promise<string> {
  const bytes = fromB64(text.slice(1));
  if (text.startsWith("z")) {
    if (typeof DecompressionStream !== "function") throw new Error("this browser cannot unpack the link");
    return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
  }
  return new TextDecoder().decode(bytes);
}

/** The link others can open: the live demo when this page runs locally, this page otherwise. */
function baseUrl(): string {
  const local = !location.protocol.startsWith("http") || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".local");
  return local ? DEMO_URL : `${location.origin}${location.pathname}`;
}

export async function makeLink(params: Params, selectedLayer: number): Promise<string> {
  const p: Bundle["params"] = { dimension: params.dimension };
  for (const s of SLIDERS) p[s.key] = Number(params[s.key]);
  for (const s of SELECTS) p[s.key] = String(params[s.key]);
  p["voiceTune"] = params.voiceTune; // lives in the microphone card, not in the slider list
  const store: Bundle["store"] = {};
  for (const k of STORE_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v) store[k] = v;
    } catch {
      // storage blocked: the link then carries the sliders only
    }
  }
  const bundle: Bundle = { v: 1, params: p, store, layer: selectedLayer };
  return `${baseUrl()}#s=${await pack(JSON.stringify(bundle))}`;
}

/** If the URL carries a shared state: ask, store it and reload. Returns true when a reload is under way. */
export async function consumeHash(): Promise<boolean> {
  const m = /^#s=([zr][A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m?.[1]) return false;
  try {
    const text = await unpack(m[1]);
    if (text.length > MAX_BYTES) throw new Error("the link is too big");
    const b = JSON.parse(text) as Partial<Bundle>;
    if (b.v !== 1 || typeof b.params !== "object" || b.params === null) throw new Error("not a share link of this app");
    if (!confirm("This link carries someone's sliders and learned state (sand wiring, band personality, taste). Load it? It replaces what this browser has learned so far.")) {
      history.replaceState(null, "", location.pathname + location.search);
      return false;
    }
    for (const k of STORE_KEYS) {
      const v = b.store?.[k];
      if (typeof v === "string") localStorage.setItem(k, v);
    }
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ params: b.params, layer: b.layer }));
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
    return true;
  } catch (e) {
    history.replaceState(null, "", location.pathname + location.search);
    alert(`The share link could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** One-shot, at startup: apply the sliders of a link that was stored before the reload. Returns the layer to select, or null. */
export function loadSharedParams(params: Params): number | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PARAMS_KEY);
    localStorage.removeItem(PARAMS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { params?: Record<string, unknown>; layer?: unknown };
    const p = d.params ?? {};
    const dim = Number(p["dimension"]);
    if (dim === 1 || dim === 2 || dim === 3) params.dimension = dim as Dimension;
    for (const s of SLIDERS) {
      const v = p[s.key];
      if (typeof v === "number" && Number.isFinite(v)) params[s.key] = Math.min(s.max, Math.max(s.min, v));
    }
    for (const s of SELECTS) {
      const v = p[s.key];
      if (typeof v === "string" && s.options.some((o) => o.value === v)) Object.assign(params, { [s.key]: v });
    }
    const tune = p["voiceTune"];
    if (typeof tune === "number" && Number.isFinite(tune)) params.voiceTune = Math.min(1, Math.max(0, tune));
    const layer = Number(d.layer);
    return Number.isInteger(layer) && layer >= 0 && layer < 10 ? layer : null;
  } catch {
    return null;
  }
}
