// Dev relay for the free-text feedback queue of Eftelaing-dust.
//
//   node server/relay.ts          HTTP relay on 127.0.0.1:8787, also serves dist/index.html
//   node server/relay.ts --mcp    MCP server on stdio for an AI assistant (reads and acknowledges the same queue)
//
// The browser app POSTs notes to /api/feedback; they are appended to feedback/notes.jsonl. The MCP server lists the open
// notes (with the sliders / band snapshot taken when each was written) so an assistant can analyse what is really lacking.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "feedback");
const NOTES = join(DIR, "notes.jsonl");
const ACKS = join(DIR, "acks.jsonl");
const COMMANDS = join(DIR, "commands.jsonl");
const STATE = join(DIR, "state.json");
const PORT = Number(process.env["PORT"] ?? 8787);
const MAX_BODY = 64 * 1024;

interface Note {
  id: string;
  t: string;
  /** Unix time in milliseconds when the human wrote it (browser clock) and when the relay got it: arrivals can be late or out of order. */
  ts: number;
  receivedAt: string;
  receivedTs: number;
  text: string;
  rating?: string;
  hints?: string[];
  context: Record<string, unknown>;
}
interface Ack {
  id: string;
  at: string;
  ts?: number;
  reply: string;
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

function append(file: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function listNotes(status: "open" | "all", limit: number): (Note & { acked?: Ack })[] {
  const acks = new Map(readLines<Ack>(ACKS).map((a) => [a.id, a]));
  const all = readLines<Note>(NOTES).map((n) => {
    const a = acks.get(n.id);
    return a ? { ...n, acked: a } : n;
  });
  const sel = status === "open" ? all.filter((n) => !("acked" in n)) : all;
  return sel.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).slice(-limit);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates an untrusted note body from the browser. */
function parseNote(body: unknown): Note | string {
  if (!isRecord(body)) return "body must be an object";
  const { id, t, ts, text, rating, hints, context } = body;
  if (typeof text !== "string" || !text.trim()) return "text is required";
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return "id is required";
  const note: Note = {
    id,
    t: typeof t === "string" ? t.slice(0, 40) : new Date().toISOString(),
    ts: typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now(),
    receivedAt: new Date().toISOString(),
    receivedTs: Date.now(),
    text: text.trim().slice(0, 2000),
    context: {},
  };
  if (typeof rating === "string") note.rating = rating.slice(0, 20);
  if (Array.isArray(hints)) note.hints = hints.filter((h): h is string => typeof h === "string").slice(0, 24).map((h) => h.slice(0, 40));
  if (isRecord(context) && JSON.stringify(context).length <= 40_000) note.context = context;
  return note;
}

function storeNote(note: Note): boolean {
  if (readLines<Note>(NOTES).some((n) => n.id === note.id)) return false;
  append(NOTES, note);
  return true;
}

function ack(id: string, reply: string): boolean {
  if (!readLines<Note>(NOTES).some((n) => n.id === id)) return false;
  append(ACKS, { id, at: new Date().toISOString(), ts: Date.now(), reply: reply.slice(0, 4000) } satisfies Ack);
  return true;
}

/** A request from the assistant to move sliders of the running app; the browser polls for them and applies what it knows. */
interface Command {
  seq: number;
  at: string;
  ts: number;
  set: Record<string, number | string>;
  why: string;
}

function readCommands(): Command[] {
  return readLines<Command>(COMMANDS);
}

/** Validates the slider values the assistant sends: at most 40 keys, short names, numbers or short strings only. */
function parseSet(values: unknown): Record<string, number | string> | string {
  if (!isRecord(values)) return "values must be an object of slider name to value";
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) return `bad slider name ${k.slice(0, 40)}`;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && v.length <= 32) out[k] = v;
    else return `bad value for ${k}`;
  }
  const n = Object.keys(out).length;
  return n === 0 ? "no sliders given" : n > 40 ? "too many sliders" : out;
}

function addCommand(set: Record<string, number | string>, why: string): Command {
  const cmd: Command = { seq: readCommands().length + 1, at: new Date().toISOString(), ts: Date.now(), set, why: why.slice(0, 300) };
  append(COMMANDS, cmd);
  return cmd;
}

function readState(): unknown {
  if (!existsSync(STATE)) return null;
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function stats(): Record<string, unknown> {
  const notes = readLines<Note>(NOTES);
  const acked = new Set(readLines<Ack>(ACKS).map((a) => a.id));
  const byRating: Record<string, number> = {};
  const byHint: Record<string, number> = {};
  for (const n of notes) {
    if (n.rating) byRating[n.rating] = (byRating[n.rating] ?? 0) + 1;
    for (const h of n.hints ?? []) byHint[h] = (byHint[h] ?? 0) + 1;
  }
  return { total: notes.length, open: notes.filter((n) => !acked.has(n.id)).length, byRating, byHint };
}

// ---- HTTP relay ----

const ALLOWED_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https:\/\/springyworks\.github\.io)$/;

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (!ALLOWED_ORIGIN.test(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-private-network", "true");
  return true;
}

function send(res: ServerResponse, code: number, body: unknown, type = "application/json"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!cors(req, res)) return send(res, 403, { error: "origin not allowed" });
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = join(ROOT, "dist", "index.html");
    if (!existsSync(page)) return send(res, 404, "run npm run build first", "text/plain");
    return send(res, 200, readFileSync(page, "utf8"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, ...stats() });
  if (req.method === "GET" && url.pathname === "/api/feedback") {
    const status = url.searchParams.get("status") === "all" ? "all" : "open";
    return send(res, 200, listNotes(status, 200));
  }
  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const note = parseNote(await readBody(req));
    if (typeof note === "string") return send(res, 400, { error: note });
    return send(res, 200, { ok: true, duplicate: !storeNote(note) });
  }
  if (req.method === "GET" && url.pathname === "/api/commands") {
    const all = readCommands();
    const after = Number(url.searchParams.get("after"));
    return send(res, 200, { seq: all.length, commands: Number.isFinite(after) && url.searchParams.has("after") ? all.filter((c) => c.seq > after) : [] });
  }
  if (req.method === "POST" && url.pathname === "/api/state") {
    const body = await readBody(req);
    if (!isRecord(body) || JSON.stringify(body).length > 60_000) return send(res, 400, { error: "bad state" });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ ...body, receivedAt: new Date().toISOString() }));
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/ack") {
    const body = await readBody(req);
    if (!isRecord(body) || typeof body["id"] !== "string") return send(res, 400, { error: "id is required" });
    const reply = typeof body["reply"] === "string" ? body["reply"] : "";
    return send(res, ack(body["id"], reply) ? 200 : 404, { ok: true });
  }
  return send(res, 404, { error: "not found" });
}

function serve(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    });
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`feedback relay: http://127.0.0.1:${PORT}/  (app + POST /api/feedback)  notes in ${NOTES}`);
  });
}

// ---- MCP server on stdio (newline-delimited JSON-RPC 2.0) ----

const TOOLS = [
  {
    name: "list_feedback",
    description:
      "List free-text feedback notes the human wrote while steering the Eftelaing-dust instrument (Monte Carlo exerciser). Each note carries the rating, hint chips and a snapshot of the sliders, band instruments, chord and layer state at that moment. Use it to find which built-in features are lacking.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "all"], description: "open = not yet acknowledged (default)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "most recent N notes (default 30)" },
      },
    },
  },
  {
    name: "ack_feedback",
    description: "Mark a note as handled and store a short reply or the analysis result with it.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, reply: { type: "string" } }, required: ["id"] },
  },
  {
    name: "feedback_stats",
    description: "Counts of notes by status, rating and hint chip.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_state",
    description:
      "The live state of the running app as last reported by the browser (every few seconds): all sliders with their current value, range and meaning, the band style, phrase, chord, instruments, the brain's personality (riff pool, generation) and learning state. Read it before set_sliders to see the valid names and ranges.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_sliders",
    description:
      "Move sliders / selects of the running Eftelaing-dust app (the browser applies them within a couple of seconds, clamped to each slider's range, and the Monte Carlo exerciser treats them like the human's own moves). Examples: bandRiffs 0..1 (how often the lead runs and riffs), bandVariation, bandEvolve, bandGroove, bandHuman, bandStyle ('auto','swing','bebop','fusion','funk','bossa','baroque'), tempo. Use get_state for the full list.",
    inputSchema: {
      type: "object",
      properties: {
        values: { type: "object", description: "slider name to new value (number, or string for selects)", additionalProperties: { type: ["number", "string"] } },
        why: { type: "string", description: "one line on why, shown to the human" },
      },
      required: ["values"],
    },
  },
] as const;

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], isError };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "list_feedback") {
    const status = args["status"] === "all" ? "all" : "open";
    const limit = typeof args["limit"] === "number" ? Math.min(200, Math.max(1, Math.floor(args["limit"]))) : 30;
    return textResult(listNotes(status, limit));
  }
  if (name === "ack_feedback") {
    if (typeof args["id"] !== "string") return textResult("id is required", true);
    const reply = typeof args["reply"] === "string" ? args["reply"] : "";
    return ack(args["id"], reply) ? textResult("acknowledged") : textResult("unknown note id", true);
  }
  if (name === "feedback_stats") return textResult(stats());
  if (name === "get_state") return textResult(readState() ?? "no state yet: open the app with the relay running");
  if (name === "set_sliders") {
    const set = parseSet(args["values"]);
    if (typeof set === "string") return textResult(set, true);
    const cmd = addCommand(set, typeof args["why"] === "string" ? args["why"] : "");
    return textResult(`queued as command ${cmd.seq}; the browser applies it within a few seconds (check get_state, lastCommand)`);
  }
  return textResult(`unknown tool ${name}`, true);
}

function mcp(): void {
  const out = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (!isRecord(msg) || typeof msg["method"] !== "string") return;
    const id = msg["id"];
    const params = isRecord(msg["params"]) ? msg["params"] : {};
    if (id === undefined) return; // notification, e.g. notifications/initialized
    switch (msg["method"]) {
      case "initialize":
        return out({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eftelaing-feedback", version: "1.0.0" },
          },
        });
      case "ping":
        return out({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        const args = isRecord(params["arguments"]) ? params["arguments"] : {};
        return out({ jsonrpc: "2.0", id, result: callTool(String(params["name"]), args) });
      }
      default:
        return out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg["method"])}` } });
    }
  });
}

if (process.argv.includes("--mcp")) mcp();
else serve();
