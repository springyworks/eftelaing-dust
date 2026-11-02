// Free-text feedback queue. Notes are kept in this browser and relayed to the local dev relay (server/relay.ts), where an
// AI assistant can read them through MCP and analyse which built-in features are really lacking.

export interface Note {
  id: string;
  t: string;
  text: string;
  rating?: string;
  hints?: string[];
  context: Record<string, unknown>;
}

const KEY = "eftelaing-dust-feedback-queue-v1";
const RELAY = "http://127.0.0.1:8787";

let snapshot: () => Record<string, unknown> = () => ({});
let queue: Note[] = load();
let sending = false;
let status = "";
const listeners = new Set<() => void>();

function load(): Note[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Note[]) : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue.slice(-200)));
  } catch {
    // storage may be blocked; the queue then lasts for this session
  }
}

/** The app registers a function returning the current state (sliders, band, instruments) to attach to every note. */
export function setSnapshot(fn: () => Record<string, unknown>): void {
  snapshot = fn;
}

export function onFeedbackChange(fn: () => void): void {
  listeners.add(fn);
}

export function feedbackStatus(): string {
  const n = queue.length;
  return `${n} note${n === 1 ? "" : "s"} waiting for the relay${status ? ` (${status})` : ""}`;
}

export function pendingNotes(): number {
  return queue.length;
}

/** Queues a note and tries to hand it to the relay. A rating alone (no text) is still worth relaying. Returns false when there is nothing to send. */
export function queueNote(text: string, extra: { rating?: string; hints?: string[] } = {}): boolean {
  const clean = text.trim().slice(0, 2000) || (extra.rating ? "(rating only, no text)" : "");
  if (!clean) return false;
  const note: Note = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, t: new Date().toISOString(), text: clean, context: snapshot() };
  if (extra.rating) note.rating = extra.rating;
  if (extra.hints?.length) note.hints = extra.hints;
  queue.push(note);
  save();
  listeners.forEach((f) => f());
  void flush();
  return true;
}

async function post(base: string, note: Note): Promise<boolean> {
  const res = await fetch(`${base}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note) });
  return res.ok;
}

/** Sends waiting notes oldest first; stops at the first failure and keeps the rest queued. */
export async function flush(): Promise<void> {
  if (sending || queue.length === 0) return;
  sending = true;
  try {
    while (queue.length > 0) {
      const note = queue[0] as Note;
      const bases = location.protocol.startsWith("http") ? [location.origin, RELAY] : [RELAY];
      let ok = false;
      for (const b of bases) {
        try {
          if (await post(b, note)) {
            ok = true;
            break;
          }
        } catch {
          // relay not running there
        }
      }
      if (!ok) {
        status = "relay not running: npm run relay";
        return;
      }
      queue.shift();
      status = "";
      save();
    }
  } finally {
    sending = false;
    listeners.forEach((f) => f());
  }
}

// Retry in the background, so notes written while the relay was down arrive when it starts.
setInterval(() => void flush(), 15000);
