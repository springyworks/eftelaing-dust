// Remote slider control through the dev relay: an AI assistant (over MCP: set_sliders / get_state) can talk to the running
// app. The app reports its state every few seconds and polls for slider commands; every value is clamped to the slider's
// range, only known sliders and select options are accepted, and the exerciser sees a command as a move by the human.

import type { Params } from "./model";
import { SELECTS, SLIDERS } from "./ui";

const RELAY = "http://127.0.0.1:8787";

interface Command {
  seq: number;
  set: Record<string, number | string>;
  why?: string;
}

export interface RemoteHooks {
  snapshot(): Record<string, unknown>;
  applied(): void;
  say(text: string): void;
}

export function startRemote(params: Params, hooks: RemoteHooks): void {
  const bases = location.protocol.startsWith("http") ? [location.origin, RELAY] : [RELAY];
  let base: string | null = null;
  let after: number | null = null;
  let lastCommand = "";

  const apply = (c: Command): string => {
    const done: string[] = [];
    const rejected: string[] = [];
    const p = params as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.set)) {
      const slider = SLIDERS.find((s) => s.key === k);
      const select = SELECTS.find((s) => s.key === k);
      if (slider && typeof v === "number") {
        const x = Math.min(slider.max, Math.max(slider.min, v));
        p[k] = x;
        document.dispatchEvent(new CustomEvent("slider-input", { detail: k }));
        done.push(`${k}=${x}`);
      } else if (select && typeof v === "string" && select.options.some((o) => o.value === v)) {
        p[k] = v;
        done.push(`${k}=${v}`);
      } else rejected.push(k);
    }
    hooks.applied();
    const text = `#${c.seq} ${done.join(", ") || "nothing applied"}${rejected.length ? ` (unknown or invalid: ${rejected.join(", ")})` : ""}`;
    hooks.say(`The assistant set ${done.join(", ") || "nothing"}${c.why ? `: ${c.why}` : ""}`);
    return text;
  };

  const find = async (): Promise<string | null> => {
    if (base) return base;
    for (const b of bases) {
      try {
        const r = await fetch(`${b}/api/commands`);
        if (r.ok) {
          const j = (await r.json()) as { seq: number };
          after = j.seq; // commands from before this session are not replayed
          return (base = b);
        }
      } catch {
        // not running there
      }
    }
    return null;
  };

  const poll = async (): Promise<void> => {
    const b = await find();
    if (!b || after === null) return;
    try {
      const r = await fetch(`${b}/api/commands?after=${after}`);
      if (!r.ok) return;
      const j = (await r.json()) as { seq: number; commands: Command[] };
      for (const c of j.commands) lastCommand = apply(c);
      after = j.seq;
    } catch {
      base = null;
    }
  };

  const report = async (): Promise<void> => {
    if (!base) return;
    const sliders: Record<string, { value: number; min: number; max: number; label: string }> = {};
    for (const s of SLIDERS) sliders[s.key] = { value: Number(params[s.key]), min: s.min, max: s.max, label: s.label };
    const selects: Record<string, { value: string; options: string[] }> = {};
    const p = params as unknown as Record<string, unknown>;
    for (const s of SELECTS) selects[s.key] = { value: String(p[s.key]), options: s.options.map((o) => o.value) };
    try {
      await fetch(`${base}/api/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sliders, selects, lastCommand, ...hooks.snapshot(), params: undefined }) });
    } catch {
      base = null;
    }
  };

  setInterval(() => void poll(), 2000);
  setInterval(() => void report(), 5000);
  void poll();
}
