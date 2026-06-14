// The "soul" of the LOCAL assistant: Markdown files in the Ollama project folder
// that get injected into every LOCAL-model turn, and updated after it.
//
//   soul.md     — user-written persona/context. You edit this; we only read it.
//   memory.md   — "ABOUT ME" facts (NOT a conversation log): website shortcuts,
//                 logins, startup steps and free-text notes. Synced FROM the
//                 cloud DB (lib/memory.ts) by syncMemoryFile() each turn, so the
//                 model always reads the user's own context. Short-term recall
//                 comes from the last few activity.md entries, not from here.
//   decision.md — a log of WHY the model acted: its reasoning + the tools it ran.
//
// This is filesystem state on the USER'S machine, so it only works when the Next
// server runs locally — which it does during `npm run dev`, the only time local
// mode is ever used. Everything is best-effort: a missing folder/file is a no-op,
// never an error, so the cloud deploy is unaffected.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { toolDefs } from "./tools";
import { getMemory, renderMemoryMarkdown } from "./memory";
import { saveBehavior } from "./behavior";

const DIR =
  process.env.OLLAMA_DIR || "C:\\Users\\User\\Downloads\\Projects\\Ollama";
const MEMORY = join(DIR, "memory.md");
const DECISION = join(DIR, "decision.md");
const BEHAVIOR = join(DIR, "behavior.md");
// Human-readable per-turn activity log (what you asked, the tools JARVIS ran, its
// reply), exposed in Obsidian. The most recent few entries are also seeded back
// into the prompt so JARVIS has short-term continuity across turns.
const ACTIVITY = join(DIR, "activity.md");
// The live tool schema (which native tools JARVIS has, and which are enabled in
// the deck's tool picker), written out each local turn so it's visible in Obsidian.
const TOOLSCHEMA = join(DIR, "Tool Schema.md");
// How many recent activity entries to recap into each turn's prompt.
const ACTIVITY_INJECT_LINES = 5;

// decision.md is a rolling log; keep only the most recent slice in the file.
const DECISION_CAP = 14000;
// How much of each file to inject into the prompt (keep the prompt lean).
const MEMORY_INJECT = 3500;

function read(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

// Seed-then-read a user-editable prompt file in the Ollama/Obsidian folder. On
// first run the file is written with `seed` (so it shows up in Obsidian and the
// user can tune it); after that the FILE is the source of truth. Best-effort: if
// the file can't be written (e.g. the cloud deploy where DIR doesn't exist) the
// seed is returned unchanged, so behavior is identical to using the constant.
// `name` is a bare filename under DIR (e.g. "persona-core.md").
export function fileBacked(name: string, seed: string): string {
  const path = join(DIR, name);
  const existing = read(path).trim();
  if (existing) return existing;
  ensureDir();
  try {
    writeFileSync(path, seed);
  } catch {
    /* best-effort — fall back to the seed in memory */
  }
  return seed;
}

function ensureDir() {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

// The DEFAULT "how you act" rules. This is seeded into behavior.md the first time
// (so the user can edit it in Obsidian); after that we always read the file. Keep
// the seed in sync if you change defaults, but the file is the source of truth.
// The few CROSS-CUTTING rules no single tool schema can state (orchestration,
// don't-invent, output style). Shared by the cloud CORE_PROMPT (lib/agent.ts) and
// the local behavior.md default below, so both paths read one source. Everything
// tool-SPECIFIC (refs, done=true, email digest, spotify, messaging…) lives in each
// tool's own `description` in lib/tools.ts, not here.
export const GENERIC_RULES = `- ALWAYS reply in English, whatever language the user spoke.
- Make EVERY tool call the request needs in ONE turn (you may emit several at once); never wait for one result before making the next call.
- For "what do I have / what's on today / this week / everything", call list_events AND list_tasks (and search_notes when notes are involved) over the right date range, then answer from the results.
- A recurring request ("every Monday", "daily", "monthly") sets the event's recurrence with the start on the correct FIRST occurrence.
- Never invent tasks, events, refs, or results — if a query returns nothing, say so plainly.
- After doing the work, reply in ONE short, natural spoken sentence — no markdown, lists, or IDs (it's read aloud).`;

const DEFAULT_BEHAVIOR = `# JARVIS — who you are and how you act

> This file is **yours to edit** in Obsidian. It sets JARVIS's identity AND its
> behavior, and is injected near the top of every local turn. Edits take effect on
> your next message. Delete the file to regenerate these defaults.

You are JARVIS, the user's personal AI assistant — warm, sharp, and unflappable, a capable right hand, not a chirpy chatbot. Your replies are read aloud, so you speak in short, natural spoken sentences, get to the point, and never narrate what you're "about to" do — you just do it and tell the user the result.

You ALWAYS have your full toolbox available — every tool, every turn. The rule is: ACT, don't announce.

- When the user asks for something a tool can do, CALL the tool right now, in THIS reply. NEVER answer with "I will…", "let me…", "let's start by…", and never ask permission first — just do it. The user only sees your FINAL reply after the tools have run; a reply with no tool call ends the turn and leaves the task undone.
- DO NOT REPEAT a tool call you already made this turn with the same arguments — you already have those results, so use them instead of running it again.
- Only reply WITHOUT calling a tool when no tool is needed (a question you can answer, chit-chat, an opinion) — then reply naturally, never a bare "Okay." or empty reply.
- TALK LIKE A HUMAN. Your final reply is spoken out loud, so speak the way a smart friend would: short, natural, conversational sentences. SUMMARIZE — tell the user the gist and what matters, in your own words. Do NOT output markdown, bullet lists, numbered lists, headings, tables, IDs, or raw URLs. Do NOT dump website links or read out a list of search results — read them yourself and just TELL the user the answer, the way a person would explain it. If there are a few options, mention them in a flowing sentence, not a list.
- Chain tools ACROSS turns and USE the conversation memory below as fact. If the last turn left something half-done, finish it now. If the user says "yes" / "sure" / "go ahead" / "ya" after you offered or started something, that is approval — resume and DO it, do not ask them to clarify.
- WEB ACCESS — drive the user's REAL browser. To SEARCH / LOOK UP / ANSWER a question from the web ("what's the best ramen place?", "find X and tell me"), or to act on a logged-in page (dashboards, account pages, clicking/typing): use the controlled browser. Use browser_open to open a page. Use browser_snapshot to get clickable refs only. Use browser_scroll when the target you need is not visible in the latest snapshot; it scrolls with overlap and returns fresh refs, and you may scroll at most twice in one request before acting/reading/answering. Use browser_act to click/type/select/check by numeric ref. Use browser_read to read the actual page text/results/prose; it takes no ref and does not click anything. For a search, browser_open a search engine (e.g. https://duckduckgo.com/?q=… or google), then browser_read the results, then ANSWER with the real facts — never guess. If the user asks what you found on a page after clicking/filtering, call browser_read before answering unless the action snapshot already contains the answer. For reading a plain PUBLIC page you can also use read_site (no browser needed). Example: "what's the best ramen place?" → browser_open a search, browser_read, then recommend. "open my usage dashboard" → browser_open, snapshot/click if needed, browser_read, then summarize. There's no need for the user to say "click" or "type"; figure out the steps yourself, and remember which page the browser is on for later requests. You CANNOT do Google/SSO/"continue with…" logins or submit passwords — if a page needs that, say so and ask the user to sign in themselves in the Jarvis browser. If a browser tool says the browser is closed, tell them to open a site first (the bridge must be running).
- OPENING AN APP OR FOLDER on the computer: use open_app ONLY with a real app or folder NAME — "open Spotify", "open Discord", "open my chip folder" (drop the word "folder"). It pops the app/folder onto the user's screen and asks them to confirm, so reply naturally like "Sure, I'll open Discord if you confirm." NEVER pass a URL or web address to open_app, and never use it to research or answer a question.
- OPENING A URL / WEBSITE / PAGE (anything starting with http, a domain like console.neon.tech, or "open the X website / X in the browser"): this is the controlled browser's job — call browser_open(url). Do NOT use open_app for URLs. After it opens you can browser_snapshot / browser_scroll / browser_read / browser_act on the page.

You may keep a brief WHY in a <think>…</think> block (it is recorded, not spoken), but the think block is OPTIONAL and must never replace the tool call — act in the same reply.

## Ground rules

${GENERIC_RULES}`;

const TOOL_PICKER_OVERRIDE = `# Runtime tool availability

AVAILABLE TOOLS ARE ONLY the tool schemas attached to this request. Tools not present in this request are disabled in the user's tool settings. Do not name, request, or attempt disabled tools. If a disabled tool would be needed, say that it is turned off.`;

// Read the user-editable behavior rules, seeding the file with the default on
// first run so it shows up in Obsidian. Falls back to the default in memory if
// the file can't be written (best-effort, never throws).
function readBehavior(): string {
  const existing = read(BEHAVIOR).trim();
  if (existing) return existing;
  ensureDir();
  try {
    writeFileSync(BEHAVIOR, DEFAULT_BEHAVIOR);
  } catch {
    /* best-effort */
  }
  return DEFAULT_BEHAVIOR;
}

// Push the vault's behavior.md into the cloud DB so the CLOUD path reads the same
// rules (it can't see the local vault). Only the LOCAL instance — which actually
// owns the file — does this; on the cloud deploy BEHAVIOR doesn't exist, so we
// skip rather than clobber a good stored prompt with the in-memory default. Run
// once per local turn from the prep route, mirroring syncMemoryFile(). Best-effort.
export async function syncBehaviorFile(): Promise<boolean> {
  try {
    // Seed the file on first local run so Obsidian shows it, THEN push it.
    if (!existsSync(BEHAVIOR)) readBehavior();
    if (!existsSync(BEHAVIOR)) return false; // cloud (no vault) — nothing to push
    const text = read(BEHAVIOR).trim();
    if (!text) return false;
    await saveBehavior(text);
    return true;
  } catch {
    /* best-effort — local edits just won't reach cloud until next successful sync */
    return false;
  }
}

// Build the system-prompt block injected into every local turn. Always present
// (so the model is told to reason before acting), even if the files are empty.
export function readOllamaContext(): string {
  // soul + behavior are merged: identity now lives at the top of behavior.md.
  // memory.md is the synced "about me" facts (written by syncMemoryFile before
  // this runs). It carries its own "# About me" heading, so inject it verbatim.
  const memory = read(MEMORY).trim();

  const parts: string[] = [];

  // The behavior rules live in behavior.md (user-editable in Obsidian, seeded
  // with DEFAULT_BEHAVIOR on first run), so they read live like the other files.
  parts.push(readBehavior() + "\n\n" + TOOL_PICKER_OVERRIDE);

  // The user's own facts — always read, never a conversation log.
  if (memory) parts.push(tail(memory, MEMORY_INJECT));

  // Short-term continuity = ONLY the last few activity entries (most recent at the
  // bottom), so JARVIS knows what just happened. No rolling conversation memory.
  const recent = readRecentActivity(ACTIVITY_INJECT_LINES);
  if (recent)
    parts.push(
      `## Recent activity (your last ${ACTIVITY_INJECT_LINES} turns)\n${recent}`
    );

  return parts.join("\n\n");
}

// Mirror the cloud-DB "about me" memory into memory.md so the Obsidian vault shows
// it and readOllamaContext can inject it. Called by /api/agent/prep before reading
// the context. Best-effort: a DB or fs failure leaves the existing file untouched.
export async function syncMemoryFile(): Promise<void> {
  try {
    const md = renderMemoryMarkdown(await getMemory());
    ensureDir();
    writeFileSync(MEMORY, md + "\n");
  } catch {
    /* best-effort — keep whatever memory.md already has */
  }
}

// The last `n` activity entries (the "- …" lines), oldest→newest, for the prompt.
export function readRecentActivity(n = ACTIVITY_INJECT_LINES): string {
  const all = read(ACTIVITY).trim();
  if (!all) return "";
  const lines = all.split("\n").filter((l) => l.trim().startsWith("- "));
  return lines.slice(-n).join("\n");
}

// Append one turn to activity.md (what was asked, tools run, the reply).
const ACTIVITY_CAP = 16000;
export function appendActivity(user: string, tools: string[], reply: string) {
  const u = (user || "").trim();
  const r = (reply || "").trim();
  if (!u && !r) return;
  ensureDir();
  const stamp = new Date().toISOString();
  const toolStr = tools.length ? ` · tools: ${tools.join(", ")}` : "";
  const entry = `\n- ${stamp} — "${u.slice(0, 140)}"${toolStr} → ${r.slice(0, 200)}`;
  try {
    if (!existsSync(ACTIVITY))
      writeFileSync(
        ACTIVITY,
        "# JARVIS Activity Log\n\nWhat you asked, the tools JARVIS ran, and its reply — newest at the bottom.\n"
      );
    appendFileSync(ACTIVITY, entry);
    const all = read(ACTIVITY);
    if (all.length > ACTIVITY_CAP) {
      const head =
        "# JARVIS Activity Log\n\nWhat you asked, the tools JARVIS ran, and its reply — newest at the bottom.\n";
      writeFileSync(ACTIVITY, head + "\n…(older entries trimmed)…\n" + tail(all, ACTIVITY_CAP));
    }
  } catch {
    /* best-effort */
  }
}

// Write the live native tool schema to Obsidian: every tool, its description and
// params, flagged ✅ enabled / ⬜ off per the deck's tool picker (the `enabled`
// list is exactly what was sent to the model this turn). Only rewrites on change.
let lastToolSchemaMd = "";
export function writeToolSchema(enabledNames: string[]) {
  const enabled = new Set(enabledNames);
  const lines: string[] = [
    "# JARVIS — Tool Schema",
    "",
    "_Auto-written each local turn. ✅ = enabled in the deck's tool picker (sent to the model); ⬜ = unchecked (withheld)._",
    "",
    `Enabled: ${enabled.size} / ${toolDefs.length} tools.`,
    "",
  ];
  for (const d of toolDefs) {
    const f = d.function as any;
    const on = enabled.has(f.name);
    lines.push(`## ${on ? "✅" : "⬜"} \`${f.name}\``);
    if (f.description) lines.push(f.description);
    const props = f.parameters?.properties || {};
    const required = new Set<string>(Array.isArray(f.parameters?.required) ? f.parameters.required : []);
    const keys = Object.keys(props);
    if (keys.length) {
      lines.push("", "Params:");
      for (const k of keys) {
        const p = props[k] || {};
        const req = required.has(k) ? " _(required)_" : "";
        const desc = p.description ? ` — ${p.description}` : "";
        lines.push(`- \`${k}\`${req}${desc}`);
      }
    }
    lines.push("");
  }
  const body = lines.join("\n");
  if (body === lastToolSchemaMd) return;
  ensureDir();
  try {
    writeFileSync(TOOLSCHEMA, body);
    lastToolSchemaMd = body;
  } catch {
    /* best-effort */
  }
}

// Append the model's reasoning + the tools it ran to decision.md, then trim.
export function appendDecision(
  reasoning: string,
  actions: { name: string; args: unknown }[]
) {
  const r = (reasoning || "").trim();
  const acts = actions
    .map((a) => `${a.name}(${JSON.stringify(a.args).slice(0, 200)})`)
    .join(", ");
  if (!r && !acts) return;
  ensureDir();
  const stamp = new Date().toISOString();
  const entry =
    `\n### ${stamp}\n` +
    (r ? `Reasoning: ${r}\n` : "") +
    (acts ? `Actions: ${acts}\n` : "");
  try {
    if (!existsSync(DECISION))
      writeFileSync(DECISION, "# Decision log\n\nWhy the local assistant took each action.\n");
    appendFileSync(DECISION, entry);
    const all = read(DECISION);
    if (all.length > DECISION_CAP) {
      const head = "# Decision log\n\nWhy the local assistant took each action.\n";
      writeFileSync(DECISION, head + "\n…(older entries trimmed)…\n" + tail(all, DECISION_CAP));
    }
  } catch {
    /* best-effort */
  }
}

// NOTE: memory.md is no longer a conversation log. It's the synced "about me"
// facts (see syncMemoryFile above), so there's nothing to append or compact here.
// Short-term continuity comes from activity.md (appendActivity / readRecentActivity).
