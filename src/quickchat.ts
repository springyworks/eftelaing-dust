// Quick message box in the top bar: free text plus a popup of selectable keywords ("too repetitive", "oh nice, what a
// transition"). Everything goes to the feedback queue (with unix time), where an AI assistant reads it through MCP. Keywords
// that match an exerciser hint also steer the band at once, and praise keywords count as a Nice.

import { queueNote } from "./feedback";
import { HINT_CHOICES } from "./exerciser";

interface Keyword {
  id: string;
  group: string;
  label: string;
  tip: string;
}

const PRAISE: readonly Keyword[] = [
  { id: "p-nice", group: "Praise", label: "Oh nice!", tip: "That sounded really good" },
  { id: "p-transition", group: "Praise", label: "What a transition!", tip: "A change between two parts that felt right" },
  { id: "p-relay", group: "Praise", label: "Nice relay", tip: "The hand-over between voices or instruments was lovely" },
  { id: "p-riff", group: "Praise", label: "Great riff / run", tip: "A fast line that was worth hearing" },
  { id: "p-swing", group: "Praise", label: "It swings!", tip: "Real swing feel" },
  { id: "p-beauty", group: "Praise", label: "Beautiful", tip: "Simply beautiful" },
  { id: "p-surprise", group: "Praise", label: "Nice surprise", tip: "Something unexpected that worked" },
  { id: "p-human", group: "Praise", label: "Sounds human", tip: "It felt played, not computed" },
];

const EXTRA: readonly Keyword[] = [
  { id: "x-transition", group: "Transitions", label: "Harsh transition", tip: "A change that jolts" },
  { id: "x-relay", group: "Transitions", label: "Clumsy relay", tip: "The hand-over between voices is awkward" },
  { id: "x-ending", group: "Transitions", label: "No ending / no build-up", tip: "Phrases do not start or finish with intent" },
  { id: "x-bug", group: "Other", label: "Bug / glitch", tip: "Something is broken, clipped or clicking" },
  { id: "x-idea", group: "Other", label: "Idea", tip: "A feature or experiment I would like" },
];

export interface QuickChatHooks {
  /** Applies known hint ids to the band and the sliders. */
  hints(ids: readonly string[]): void;
  /** Counts as a Nice click. */
  praise(): void;
}

export function buildQuickChat(hooks: QuickChatHooks): HTMLElement {
  const groups = new Map<string, Keyword[]>();
  for (const k of [...PRAISE, ...HINT_CHOICES, ...EXTRA]) groups.set(k.group, [...(groups.get(k.group) ?? []), k]);
  const chosen = new Set<string>();
  const chips = new Map<string, HTMLButtonElement>();

  const root = document.createElement("span");
  root.className = "qchat";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 500;
  input.placeholder = "Say it: too repetitive, oh nice...";
  input.setAttribute("aria-label", "Message to the AI assistant and the brain");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn small";
  more.setAttribute("aria-expanded", "false");
  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn small on";
  send.textContent = "Send";
  const status = document.createElement("span");
  status.className = "qchat-status";
  const panel = document.createElement("div");
  panel.className = "qchat-panel";
  panel.hidden = true;

  const label = (): void => {
    more.textContent = chosen.size ? `Keywords (${chosen.size}) ▾` : "Keywords ▾";
  };
  label();

  for (const [name, list] of groups) {
    const row = document.createElement("div");
    row.className = "qchat-row";
    const h = document.createElement("span");
    h.className = "qchat-group";
    h.textContent = name;
    row.append(h);
    for (const k of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small chip";
      b.textContent = k.label;
      b.title = k.tip;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        if (chosen.has(k.id)) chosen.delete(k.id);
        else chosen.add(k.id);
        b.classList.toggle("on", chosen.has(k.id));
        b.setAttribute("aria-pressed", String(chosen.has(k.id)));
        label();
      });
      chips.set(k.id, b);
      row.append(b);
    }
    panel.append(row);
  }
  const foot = document.createElement("div");
  foot.className = "qchat-foot";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn small";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    chosen.clear();
    for (const b of chips.values()) {
      b.classList.remove("on");
      b.setAttribute("aria-pressed", "false");
    }
    label();
  });
  const sendInPanel = document.createElement("button");
  sendInPanel.type = "button";
  sendInPanel.className = "btn small on";
  sendInPanel.textContent = "Send";
  foot.append(clear, sendInPanel);
  panel.append(foot);

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    if (open) panel.style.top = `${(root.closest("header")?.getBoundingClientRect().bottom ?? 76) + 4}px`;
    more.setAttribute("aria-expanded", String(open));
  };
  more.addEventListener("click", () => setOpen(Boolean(panel.hidden)));
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !root.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  let timer = 0;
  const submit = (): void => {
    const ids = [...chosen];
    const words = ids.map((id) => [...PRAISE, ...HINT_CHOICES, ...EXTRA].find((k) => k.id === id)?.label ?? id);
    const text = [input.value.trim(), words.length ? `[${words.join("; ")}]` : ""].filter(Boolean).join(" ");
    if (!text) {
      status.textContent = "type something or pick a keyword";
    } else {
      queueNote(text, { hints: ids });
      hooks.hints(ids);
      if (ids.some((id) => id.startsWith("p-"))) hooks.praise();
      status.textContent = "sent ✓";
      input.value = "";
      clear.click();
      setOpen(false);
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (status.textContent = ""), 3000);
  };
  send.addEventListener("click", submit);
  sendInPanel.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  root.append(input, more, send, status, panel);
  return root;
}
