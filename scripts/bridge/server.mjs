#!/usr/bin/env node
// PersonalAI local bridge.
//
// A tiny companion process that runs ON your computer and is the ONLY thing
// allowed to launch local things. The web app proposes an action, you confirm
// it in the browser, and the browser sends it here. Safety:
//   - binds to 127.0.0.1 only (not reachable from the network)
//   - requires a bearer token (printed on startup, persisted to .bridge-token)
//   - only two verbs, both with strict argument validation — never free shell
//
// Verbs:
//   open      -> open a URL / URI in the default handler (browser, Spotify…)
//   open_app  -> launch an installed app by name
//
// Run:  node scripts/bridge/server.mjs     (or: npm run bridge)

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pageOpen, pageSnapshot, pageText, pageScroll, pageAct, closeBrowser } from "./browser.mjs";

// Load the app's .env.local (project root) so the bridge can read SITE_URL etc.
// Best-effort: a missing file just leaves process.env untouched. Shell-exported
// vars still win (dotenv does not override already-set keys).
try {
  const { config } = await import("dotenv");
  config({ path: join(dirname(fileURLToPath(import.meta.url)), "../../.env.local") });
} catch { /* dotenv optional — fall back to shell env */ }

const HOST = "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT) || 7777;
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, ".bridge-token");
const platform = process.platform; // "win32" | "darwin" | "linux"

// Developer mode: arbitrary-command execution. OFF unless explicitly enabled,
// because it removes the "never free shell" guarantee the rest of this bridge
// is built on. Even when ON, every command passes two static gates (see
// inspectShell) and the BROWSER shows the literal command for a typed (not
// spoken) confirmation before it ever reaches here.
// Runtime flag, seeded from the env var. The web app can flip it via the authed
// /dev-mode endpoint (the bearer token is the gate), so you don't have to restart
// the bridge to toggle developer mode from the UI.
let shellEnabled = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_ALLOW_SHELL || "");
// Long enough for a real build/test (npm run build, npm test, tsc) to finish —
// these legitimately take minutes. Override with BRIDGE_SHELL_TIMEOUT_MS. The
// command must still EXIT on its own (no dev servers/watches); this is just the
// hard ceiling before we kill a runaway.
const SHELL_TIMEOUT_MS = Number(process.env.BRIDGE_SHELL_TIMEOUT_MS) || 300_000;
const SHELL_MAX_OUTPUT = 20_000; // chars of stdout/stderr returned to the UI

// --- Local AI backend (freellmapi) -----------------------------------------
// freellmapi runs on THIS machine (an OpenAI-compatible gateway that rotates
// free-tier provider keys, e.g. OpenRouter → Hermes, so turns cost nothing).
// The cloud app (Vercel) can't reach localhost, so the bridge is the relay: it
// proxies local-model inference for the agent's tool-calling loop AND holds the
// freellmapi bearer token, so the secret never reaches the browser. Optional —
// if it's down, /local/status reports it offline and Jarvis falls back to cloud.
//
// Set both in the bridge's own env (never in the repo / Vercel):
//   FREELLMAPI_URL  — e.g. http://localhost:8000 (match your freellmapi port)
//   FREELLMAPI_KEY  — the `freellmapi-...` bearer token from its dashboard
const FLLM_TIMEOUT_MS = Number(process.env.FREELLMAPI_TIMEOUT_MS) || 180_000;
// freellmapi's URL + key. Explicit env wins; otherwise we DISCOVER them from the
// Hermes config (`model.base_url` / `model.api_key`), since freellmapi now runs
// as Hermes' custom provider (e.g. http://localhost:3001/v1) rather than a fixed
// :8000 gateway. This keeps the secret in one place and survives a port change.
// Resolved lazily (the config dir needs a `hermes` spawn) and cached.
let fllmCache; // { url, key } | undefined
function resolveFllm() {
  if (fllmCache) return fllmCache;
  let url = process.env.FREELLMAPI_URL || "";
  let key = process.env.FREELLMAPI_KEY || "";
  if (!url || !key) {
    try {
      const cfgDir = hermesConfigDir();
      if (cfgDir) {
        const raw = readFileSync(join(cfgDir, "config.yaml"), "utf8");
        // First match of each is the top-level `model:` block (active provider).
        if (!url) { const m = raw.match(/^\s*base_url:\s*(\S+)/m); if (m) url = m[1]; }
        if (!key) { const m = raw.match(/^\s*api_key:\s*(\S+)/m); if (m) key = m[1]; }
      }
    } catch { /* no config → fall back to the default below */ }
  }
  url = (url || "http://localhost:8000").replace(/['"]/g, "").replace(/\/+$/, "").replace(/\/v1$/, "");
  key = (key || "").replace(/['"]/g, "");
  fllmCache = { url, key };
  return fllmCache;
}
const fllmHeaders = (extra = {}) => {
  const { key } = resolveFllm();
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
};

// PREFERRED status source: read freellmapi's OWN sqlite DB directly (it's a local
// file on this machine). The status board only needs PLAINTEXT columns — api_keys
// (platform/label/status/enabled) and models — so there's no decryption and no
// password/key required. Node 22's experimental node:sqlite reads it read-only.
// Forward slashes work on Windows node and avoid backslash-escaping pitfalls.
const FLLM_DB_CANDIDATES = [
  process.env.FREELLMAPI_DB,
  "C:/Users/User/Downloads/FreeLLMAPI/freellmapi/server/data/freeapi.db",
].filter(Boolean);
async function readFllmDb() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return null; }
  const path = FLLM_DB_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!path) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const keyRows = db.prepare("SELECT id, platform, label, status, enabled, last_checked_at FROM api_keys ORDER BY platform, id").all();
    const countRows = db.prepare("SELECT platform, COUNT(*) c FROM api_keys WHERE enabled = 1 GROUP BY platform").all();
    const countMap = new Map(countRows.map((r) => [r.platform, r.c]));
    let fb = new Map();
    try {
      const fbRows = db.prepare("SELECT model_db_id, priority, enabled FROM fallback_config").all();
      fb = new Map(fbRows.map((r) => [r.model_db_id, r]));
    } catch { /* table may not exist on older versions */ }
    const modelRows = db.prepare("SELECT id, platform, model_id, display_name, intelligence_rank, rpm_limit, rpd_limit, tpd_limit, context_window, enabled FROM models ORDER BY intelligence_rank, id").all();
    // Combined usage per model_id — summed across ALL keys/accounts serving that
    // model (the user has the same model, e.g. qwen3-coder, on several OpenRouter
    // accounts). `today` is the UTC date freellmapi stamps created_at with.
    let usageMap = new Map();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const usageRows = db.prepare(
        `SELECT model_id,
           COUNT(*) reqs,
           COUNT(DISTINCT key_id) usedKeys,
           COALESCE(SUM(input_tokens + output_tokens), 0) tok,
           COALESCE(SUM(CASE WHEN substr(created_at,1,10)=? THEN input_tokens + output_tokens ELSE 0 END), 0) tokToday,
           COALESCE(SUM(CASE WHEN substr(created_at,1,10)=? THEN 1 ELSE 0 END), 0) reqsToday
         FROM requests GROUP BY model_id`
      ).all(today, today);
      usageMap = new Map(usageRows.map((r) => [r.model_id, r]));
    } catch { /* requests table may not exist on older versions */ }
    db.close();
    const keys = keyRows.map((r) => ({
      id: r.id, platform: r.platform, label: r.label, maskedKey: "",
      status: r.status, enabled: r.enabled === 1, lastCheckedAt: r.last_checked_at,
    }));
    const models = modelRows.map((r) => {
      const u = usageMap.get(r.model_id);
      return {
        id: r.id, platform: r.platform, modelId: r.model_id, displayName: r.display_name,
        intelligenceRank: r.intelligence_rank, rpmLimit: r.rpm_limit, rpdLimit: r.rpd_limit,
        tpdLimit: r.tpd_limit, contextWindow: r.context_window, enabled: r.enabled === 1,
        keyCount: countMap.get(r.platform) ?? 0,
        fallbackEnabled: fb.get(r.id)?.enabled === 1, priority: fb.get(r.id)?.priority ?? null,
        // Combined usage across all keys serving this model_id.
        tokensTotal: u?.tok ?? 0, tokensToday: u?.tokToday ?? 0,
        requestsTotal: u?.reqs ?? 0, requestsToday: u?.reqsToday ?? 0,
        usageKeys: u?.usedKeys ?? 0,
      };
    });
    return { keys, models };
  } catch {
    try { db && db.close(); } catch { /* ignore */ }
    return null;
  }
}

// Write per-model caps back into freellmapi's DB. `updates` is a list of
// { platform, modelId, tpd, rpd, rpm } where each cap is a number or null (null =
// "no cap"). Opens the SAME local file read-WRITE (freellmapi tolerates a second
// connection; busy_timeout waits out a transient lock). Best-effort: returns the
// number of rows changed, or 0 on any failure. Only the columns present in each
// update are touched, so editing tpd never clobbers rpd/rpm.
async function writeFllmCaps(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return 0;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return 0; }
  const path = FLLM_DB_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!path) return 0;
  let db, changed = 0;
  try {
    db = new DatabaseSync(path);
    try { db.exec("PRAGMA busy_timeout = 4000"); } catch { /* older runtime */ }
    for (const u of updates) {
      const sets = [], args = [];
      if ("tpd" in u) { sets.push("tpd_limit = ?"); args.push(u.tpd); }
      if ("rpd" in u) { sets.push("rpd_limit = ?"); args.push(u.rpd); }
      if ("rpm" in u) { sets.push("rpm_limit = ?"); args.push(u.rpm); }
      if (!sets.length) continue;
      args.push(u.platform, u.modelId);
      const r = db.prepare(`UPDATE models SET ${sets.join(", ")} WHERE platform = ? AND model_id = ?`).run(...args);
      changed += Number(r.changes || 0);
    }
    db.close();
    return changed;
  } catch {
    try { db && db.close(); } catch { /* ignore */ }
    return 0;
  }
}

// freellmapi's /api/* ADMIN surface (keys + models with per-key status) is gated by
// a DASHBOARD SESSION token (from /api/auth/login), NOT the unified proxy key the
// bridge holds. So to read per-account key status we log in with the dashboard
// credentials (set in the bridge env) and cache the session token. Without these
// creds we fall back to the unified-key /v1/models list (model availability only).
let dashTokenCache; // string | null
async function fllmDashToken(base, { force = false } = {}) {
  if (dashTokenCache !== undefined && !force) return dashTokenCache;
  const email = process.env.FREELLMAPI_DASH_EMAIL || "";
  const password = process.env.FREELLMAPI_DASH_PASSWORD || "";
  if (!email || !password) { dashTokenCache = null; return null; }
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    dashTokenCache = res.ok && data.token ? data.token : null;
  } catch {
    dashTokenCache = null;
  }
  return dashTokenCache;
}

// --- Hermes Agent (the local "brain") --------------------------------------
// Hermes Agent (nousresearch/hermes-agent) is a self-hosted agent runtime with
// its OWN memory, skills and tools. In the "Hermes = brain, JARVIS = face"
// design, a local voice turn is just: shell out to `hermes -z "<utterance>"`
// (its pure one-shot mode: prompt in, final reply text out) and show the reply.
// Hermes does the thinking; its LLM provider is configured INSIDE Hermes
// (provider: custom → freellmapi base_url), so key rotation lives there, not here.
//
// HERMES_BIN — path to the hermes executable. If unset we resolve it via
// where/which. Python console-scripts install a hermes.exe on Windows, which
// spawns cleanly; if yours is a .cmd shim, point HERMES_BIN at the real exe.
const HERMES_BIN_ENV = process.env.HERMES_BIN || "";
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS) || 180_000;
const HERMES_MAX_OUTPUT = 100_000;
// `hermes -z` prints ONLY its final answer to stdout (reasoning/tool logs go to
// stderr). So once stdout has produced text and then gone quiet, the reply is
// ready — but the process can linger for seconds afterward on browser/CDP
// teardown and exit before `close` fires. That tail is dead time the user hears
// as "it did the thing but talks back ages later". We resolve the reply this
// long after stdout goes idle (with non-empty output) instead of waiting for
// the process to fully exit; bookkeeping still runs on the real `close`. Set
// HERMES_IDLE_FLUSH_MS=0 to disable and wait for close as before.
const HERMES_IDLE_FLUSH_MS = (() => {
  const v = process.env.HERMES_IDLE_FLUSH_MS;
  if (v === undefined) return 1200;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
})();
// Working directory for `hermes -z`. Hermes resolves AGENTS.md / rules / project
// notes from its CWD on every turn, and in one-shot YOLO mode it has file tools
// scoped there too. Pointing this at the user's Obsidian "project memory" vault
// makes that folder Hermes' live, human-editable memory: edit the markdown there
// and the next turn sees it; Hermes can append what it learns back into it. Its
// internal store (state.db / .hermes/memories) is untouched and stays in place.
const HERMES_CWD = process.env.HERMES_CWD ||
  "C:\\Users\\User\\Downloads\\Projects\\Hermes";

// Show Hermes' browser instead of running it headless. Hermes drives a headless
// Chromium sidecar (`agent-browser`) by default, so when it "opens" a site you
// never see a window. agent-browser honors the AGENT_BROWSER_HEADED env var, and
// Hermes passes its own environment straight through to that subprocess — so
// setting it on the `hermes` spawn here makes every JARVIS-driven browser turn
// pop a visible window. Default ON; set BRIDGE_HERMES_HEADED=0 to keep it hidden.
const HERMES_HEADED = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_HERMES_HEADED || "1");

// How long Hermes keeps its browser open with no activity before tearing it
// down. Hermes' default is 300s, so a visible window vanishes mid-task; agents
// also pause between one-shot turns longer than that. We bump it (default 30
// min) by pre-setting both knobs Hermes reads: BROWSER_INACTIVITY_TIMEOUT (its
// server-side cleanup thread, seconds) and AGENT_BROWSER_IDLE_TIMEOUT_MS (the
// agent-browser daemon, ms). Hermes only fills these in if absent, so ours win.
const HERMES_BROWSER_IDLE_MS = Number(process.env.BRIDGE_BROWSER_IDLE_MS) || 30 * 60 * 1000;

// Persistent, VISIBLE browser for Hermes via CDP. Root cause of "the browser
// closes by itself": in one-shot mode Hermes spawns a headless agent-browser
// daemon and, on `-z` process exit (right after it answers), its atexit handler
// KILLS that daemon and its Chrome children — so any window vanishes the instant
// the turn ends, no matter the idle timeout. The fix is to stop letting Hermes
// OWN the browser: the bridge launches ONE long-lived, visible Chrome with remote
// debugging and points Hermes at it via BROWSER_CDP_URL. Hermes then merely
// CONNECTS (and only disconnects on exit), so the window survives across turns
// and you can actually watch it. Default ON; BRIDGE_HERMES_CDP=0 reverts to the
// headless-daemon path (kept, now with the longer idle timeout above).
const HERMES_CDP = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_HERMES_CDP || "1");
const HERMES_CDP_PORT = Number(process.env.BRIDGE_HERMES_CDP_PORT) || 9222;
// Dedicated Chrome profile so logins persist (like the JARVIS browser) without
// colliding with the user's main Chrome. First use: log in once; it sticks.
const HERMES_CHROME_PROFILE = process.env.BRIDGE_HERMES_CHROME_PROFILE ||
  join(homedir(), ".jarvis-hermes-chrome");
const CHROME_BIN_ENV = process.env.BRIDGE_CHROME_BIN || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short-term memory model: a COMPACT recap of the last N turns from Activity.md,
// injected ahead of the user's words on every turn. This is now the DEFAULT and
// only memory path. `--resume` is OFF by default because, with free-model
// rotation, resuming a growing session (a) duplicated what the seed already
// injects, (b) wrecked prompt caching across models, and (c) ballooned the
// payload. Turn the old behaviour back on with BRIDGE_HERMES_RESUME=1.
// BRIDGE_HERMES_SEED_MEMORY=0 disables the seed entirely.
const HERMES_SEED = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_HERMES_SEED_MEMORY || "1");
const HERMES_RESUME = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_HERMES_RESUME || "0");
// How many recent turns the seed recaps. Runtime-mutable from the web app
// (GET/POST /hermes/seed); env sets the initial value. Default 5, clamped 0..20.
let hermesSeedTurns = clampSeedTurns(Number(process.env.BRIDGE_HERMES_SEED_TURNS) || 5);
function clampSeedTurns(n) {
  if (!Number.isFinite(n)) return 5;
  return Math.max(0, Math.min(20, Math.round(n)));
}

// --- Vault mirrors ----------------------------------------------------------
// Set BRIDGE_MODEL_SYNC=0 to turn off the remaining vault mirrors below
// (Model Caps.md and Router Cooldowns.md).
const MODEL_SYNC = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_MODEL_SYNC || "1");
// Where the app lives. SITE_URL (from .env.local) points at the deployed app;
// fall back to a local `npm run dev`. /api/models needs no auth (local config).
const JARVIS_URL = (process.env.JARVIS_URL || process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const JARVIS_VAULT = process.env.JARVIS_VAULT || "C:\\Users\\User\\Downloads\\Projects\\Jarvis Personal AI";
const MODEL_SYNC_MS = Number(process.env.BRIDGE_MODEL_SYNC_MS) || 60_000;
// Two-way mirror of the per-model daily/rate CAPS that live in freellmapi's own
// sqlite DB (the `models` table: tpd_limit / rpd_limit / rpm_limit). These caps
// are what the Pipeline "LLM Keys — token usage" board turns into each model's
// daily BUDGET (per-key cap × accounts). The board shows "—" for any model whose
// cap is null here, so this file lets you fill those in from Obsidian: edit a
// number, save, and the bridge writes it straight back into freeapi.db.
const MODEL_CAPS_FILE = join(JARVIS_VAULT, "Model Caps.md");
// Two-way mirror of the router's failure cooldowns (lib/router-config.ts, stored
// in the app DB): how long a key sits out after a rate-limit (429/413) vs a
// client error (4xx) before the router will re-pick it. Edit the minutes here,
// save, and the bridge writes them into the app within a minute.
const ROUTER_COOLDOWNS_FILE = join(JARVIS_VAULT, "Router Cooldowns.md");
// Read-only mirror of which Hermes CLI toolsets are enabled, so the user can see
// the real ✓/✗ state in Obsidian instead of the full schema in config.yaml (which
// always lists every tool DEFINITION). Re-written whenever we list/toggle tools.
const HERMES_TOOLS_FILE = join(JARVIS_VAULT, "Hermes Tools.md");
let lastHermesToolsMd = "";
function writeHermesToolsMd(tools) {
  try {
    if (!existsSync(JARVIS_VAULT)) return; // vault not on this machine — skip
    const on = tools.filter((t) => t.enabled);
    const body =
      "# Hermes — CLI Tools\n\n" +
      "_Auto-synced by the bridge from `hermes tools list --platform cli`. Read-only " +
      "(toggle from the JARVIS LOCAL AI panel). This is the real enabled set — " +
      "config.yaml's `tools:` block lists every tool DEFINITION regardless._\n\n" +
      `Last synced: ${new Date().toLocaleString("en-SG", { hour12: false })}\n\n` +
      `**${on.length}/${tools.length} enabled.**\n\n` +
      tools
        .map((t) => `- ${t.enabled ? "✅" : "⬜"} ${t.label || t.name} \`${t.name}\``)
        .join("\n") +
      "\n";
    if (body === lastHermesToolsMd) return; // nothing changed — no churn
    writeFileSync(HERMES_TOOLS_FILE, body, "utf8");
    lastHermesToolsMd = body;
  } catch { /* best-effort mirror */ }
}

// Regenerate the Hermes vault's "Tool Schemas.md" / "System Prompt.md" scoped to
// EXACTLY the toolsets we pass to `hermes -z -t <csv>`, so the user can see the
// real per-turn tool schema (and watch it shrink when they uncheck a tool). Runs
// `dump_prompt_to_obsidian.py` with the venv python ASYNCHRONOUSLY (fire-and-
// forget) so it never blocks the bridge. Best-effort: silently skips if the
// python/script aren't found (e.g. Hermes installed differently). Override paths
// with HERMES_PYTHON / HERMES_DUMP_SCRIPT.
let lastDumpedCsv = null;
function syncToolSchemasDump(csv) {
  try {
    if (csv === lastDumpedCsv) return; // toolset set unchanged — skip the spawn
    const bin = resolveHermesBin();
    // venv layout: <hermes-agent>/venv/Scripts/hermes.exe → python.exe is in the
    // same Scripts dir; the dump script lives at <hermes-agent>/.
    const scriptsDir = dirname(bin);
    const agentDir = dirname(dirname(scriptsDir));
    const pyExe = process.env.HERMES_PYTHON ||
      join(scriptsDir, platform === "win32" ? "python.exe" : "python");
    const script = process.env.HERMES_DUMP_SCRIPT ||
      join(agentDir, "dump_prompt_to_obsidian.py");
    if (!existsSync(pyExe) || !existsSync(script)) return; // not a venv install — skip
    const args = [script, "--platform", "cli"];
    if (csv) args.push("--toolsets", csv);
    const child = spawn(pyExe, args, { cwd: agentDir, windowsHide: true, stdio: "ignore" });
    child.on("error", () => { /* best-effort */ });
    child.on("exit", (code) => {
      if (code === 0) {
        lastDumpedCsv = csv;
        console.log(`[bridge] dumped Tool Schemas.md${csv ? ` (-t ${csv})` : ""}`);
      }
    });
  } catch { /* best-effort — never let the dump break a toggle */ }
}
// Aliases only for things that resolve better via a known target than by the
// normal lookup (Get-StartApps etc.). Store/PATH apps like Spotify and
// Calculator are intentionally NOT here — they resolve more reliably via
// Get-StartApps/PATH, which actually launches them.
const APP_ALIASES = {
  explorer: platform === "win32" ? "explorer.exe" : ".",
  files: platform === "win32" ? "explorer.exe" : ".",
};

// --- Validation -----------------------------------------------------------
// URLs/URIs: only safe schemes, and no quote/newline so single-quoting for the
// shell is airtight.
function validTarget(t) {
  if (typeof t !== "string" || !t || t.length > 2048) return false;
  if (/['"\r\n]/.test(t)) return false;
  return /^(https?:\/\/|spotify:|whatsapp:|mailto:|calc:|explorer\.exe)/i.test(t);
}
// App names: a single token of safe characters — no paths, no operators.
function validAppName(n) {
  return typeof n === "string" && /^[\w .:-]{1,64}$/.test(n);
}

// --- Token ----------------------------------------------------------------
function loadOrCreateToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadOrCreateToken();

// --- Launching ------------------------------------------------------------
// All launches go through the OS opener with the target as a single argument.
// We never build a shell string from raw user input; targets are validated and
// single-quotes are doubled for PowerShell's single-quoted strings.
//
// IMPORTANT: do NOT use { detached: true } on Windows — it puts the child in a
// process group with no access to the interactive desktop, so GUI apps silently
// fail to appear. We don't need it: Start-Process (and open/xdg-open) launch the
// app as its own independent process that outlives this short-lived child.
const SPAWN_OPTS = { stdio: "ignore", windowsHide: true };
function launch(target) {
  if (platform === "win32") {
    const esc = String(target).replace(/'/g, "''");
    return spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process '${esc}'`],
      SPAWN_OPTS
    );
  }
  if (platform === "darwin") return spawn("open", [target], SPAWN_OPTS);
  return spawn("xdg-open", [target], SPAWN_OPTS);
}

function openTarget(target) {
  if (!validTarget(target)) return { ok: false, error: "target not allowed" };
  try {
    launch(target);
    console.log(`[bridge] open ${target}`);
    return { ok: true };
  } catch (err) {
    console.error("[bridge] open failed:", err.message);
    return { ok: false, error: "couldn't open that" };
  }
}

// WhatsApp send: open the chat (whatsapp:// or wa.me link) with the message
// pre-filled, then — if autoSend — press Enter once after a short delay so the
// already-typed message goes out. We deliberately send ONLY {ENTER}, nothing
// else; the deep link focuses the message box for that specific chat, so Enter
// sends to the right conversation. Auto-send is best-effort and Windows-only.
const WA_SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS) || 4000;
function whatsAppSend(target, autoSend) {
  if (!validTarget(target)) return { ok: false, error: "target not allowed" };
  try {
    launch(target);
    console.log(`[bridge] whatsapp_send ${autoSend ? "(auto)" : "(prefill)"} ${target}`);
  } catch (err) {
    console.error("[bridge] whatsapp_send open failed:", err.message);
    return { ok: false, error: "couldn't open WhatsApp" };
  }
  if (autoSend && platform === "win32") {
    setTimeout(() => {
      try {
        spawn(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
          ],
          SPAWN_OPTS
        );
        console.log("[bridge] whatsapp_send: pressed Enter");
      } catch (err) {
        console.error("[bridge] whatsapp_send Enter failed:", err.message);
      }
    }, WA_SEND_DELAY_MS);
  }
  return { ok: true, autoSend: !!autoSend && platform === "win32" };
}

// Find an installed app's launch target WITHOUT launching it, so we can decide
// whether to fall back to a website. Order: alias -> Start app (covers Win32 AND
// Microsoft Store/UWP apps like WhatsApp, Discord) -> on PATH (Get-Command).
function resolveApp(name) {
  const key = name.trim().toLowerCase();
  if (APP_ALIASES[key]) return APP_ALIASES[key];
  if (platform === "win32") {
    const id = matchStartApp(key);
    if (id) return `shell:AppsFolder\\${id}`; // launches Win32 or Store apps
    const local = findLocalInstall(key); // per-user apps with no Start entry
    if (local) return local;
    const r = spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `if (Get-Command '${name.trim()}' -ErrorAction SilentlyContinue) { exit 0 } exit 1`,
    ]);
    if (r.status === 0) return name.trim();
    return null; // not found -> caller may fall back to a website
  }
  return name.trim(); // mac/linux: best-effort, no existence check
}

// Last resort: per-user "Squirrel" apps (Discord, Slack, GitHub Desktop…) that
// install under %LocalAppData%\<Name>\app-x.y.z\<Name>.exe and often have no
// Start menu entry. Scan one matching folder for the newest app exe.
const SKIP_EXE = /(unins|update|setup|crash|helper|squirrel)/i;
function findLocalInstall(key) {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  try {
    const dir = readdirSync(base, { withFileTypes: true }).find(
      (e) => e.isDirectory() && e.name.toLowerCase().includes(key)
    );
    if (!dir) return null;
    const dpath = join(base, dir.name);
    const subs = readdirSync(dpath, { withFileTypes: true });
    // newest app-* dir first, then the folder itself
    const appDirs = subs
      .filter((s) => s.isDirectory() && /^app-/i.test(s.name))
      .map((s) => s.name)
      .sort()
      .reverse()
      .map((n) => join(dpath, n));
    for (const d of [...appDirs, dpath]) {
      const exe = findExe(d, key);
      if (exe) return exe;
    }
  } catch {
    /* unreadable dir — give up */
  }
  return null;
}

function findExe(dir, key) {
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const exes = files
    .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".exe"))
    .map((f) => f.name)
    .filter((n) => !SKIP_EXE.test(n));
  const pick =
    exes.find((n) => n.toLowerCase().slice(0, -4).includes(key)) || exes[0];
  return pick ? join(dir, pick) : null;
}

// Cache of `Get-StartApps` (everything the Start menu shows, incl. Store apps).
// Refreshed lazily with a short TTL so newly-installed apps appear without a
// restart, without paying the ~300ms query on every request.
let startAppsCache = { at: 0, apps: [] };
function getStartApps() {
  if (Date.now() - startAppsCache.at < 60_000) return startAppsCache.apps;
  let apps = [];
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse(r.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    apps = list
      .filter((a) => a && a.Name && a.AppID)
      .map((a) => ({ name: String(a.Name).toLowerCase(), id: String(a.AppID) }));
  } catch {
    apps = [];
  }
  startAppsCache = { at: Date.now(), apps };
  return apps;
}

// Match the spoken name to a Start app id: exact, then starts-with, then
// contains (so "whatsapp" matches "WhatsApp", "teams" matches "Microsoft Teams").
function matchStartApp(key) {
  const apps = getStartApps();
  return (
    apps.find((a) => a.name === key)?.id ||
    apps.find((a) => a.name.startsWith(key))?.id ||
    apps.find((a) => a.name.includes(key))?.id ||
    null
  );
}

// Folders to never descend into — huge, noisy, or system. Keeps the recursive
// search fast and avoids matching junk.
const FOLDER_SKIP = /^(node_modules|appdata|\$recycle\.bin|windows|program files( \(x86\))?|programdata|\.git|\.next|\.cache|__pycache__|venv|\.venv|System Volume Information|OneDriveTemp)$/i;

// Look for a FOLDER matching `name` so "open internship orders" can open it even
// when it isn't an app. Searches the user's configured default folder first,
// then the usual spots — RECURSIVELY (breadth-first, depth-limited) so nested
// folders are found too. Exact name wins immediately; otherwise the first
// "contains" match. Bounded by depth + a scan cap so it stays fast.
function resolveFolder(name, searchFolder, maxDepth = 4, maxScan = 6000) {
  if (process.platform !== "win32") return null;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const bases = [
    searchFolder, // the user's configured default (e.g. C:\Users\You\Downloads)
    home && join(home, "Downloads"),
    home && join(home, "Documents"),
    home && join(home, "Desktop"),
    home,
  ].filter(Boolean);
  // De-dupe (the configured default is often one of the standard spots).
  const seen = new Set();
  const want = name.trim().toLowerCase();
  let containsHit = null;
  let scanned = 0;

  const queue = [];
  for (const b of bases) if (!seen.has(b.toLowerCase())) { seen.add(b.toLowerCase()); queue.push({ dir: b, depth: 0 }); }

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable / missing
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const lname = e.name.toLowerCase();
      if (e.name.startsWith(".") || FOLDER_SKIP.test(e.name)) continue;
      const full = join(dir, e.name);
      if (lname === want) return full; // exact match — done
      if (!containsHit && lname.includes(want)) containsHit = full;
      // Queue children for a deeper look, within the depth + scan budget.
      if (depth + 1 <= maxDepth && scanned < maxScan && !seen.has(full.toLowerCase())) {
        seen.add(full.toLowerCase());
        queue.push({ dir: full, depth: depth + 1 });
        scanned++;
      }
    }
  }
  return containsHit;
}

// Open by name. Default chain: app -> folder -> website fallback (if given).
// `only` forces a single kind: "app" or "folder" (skip the rest, error if missing)
// — used when the user said "open X app" / "open X folder". Returns { opened:
// "app" | "folder" | "website" }.
function openApp(name, fallback, searchFolder, only) {
  if (!validAppName(name)) return { ok: false, error: "app name not allowed" };

  // App (default, or forced with only="app"; skipped for only="folder").
  if (only !== "folder") {
    const target = resolveApp(name);
    if (target) {
      try {
        launch(target);
        console.log(`[bridge] open_app ${name} -> ${target}`);
        return { ok: true, opened: "app" };
      } catch (err) {
        console.error("[bridge] open_app failed:", err.message);
      }
    }
    if (only === "app") return { ok: false, error: `couldn't find an app called ${name}` };
  }

  // Folder (default next step, or forced with only="folder"; skipped for only="app").
  const folder = resolveFolder(name, searchFolder);
  if (folder) {
    try {
      launch(folder);
      console.log(`[bridge] open_app ${name} -> folder ${folder}`);
      return { ok: true, opened: "folder", path: folder };
    } catch (err) {
      console.error("[bridge] open folder failed:", err.message);
    }
  }
  if (only === "folder") return { ok: false, error: `couldn't find a folder called ${name}` };

  // Website fallback (default only — not for an explicit app/folder request).
  if (fallback && validTarget(fallback)) {
    const r = openTarget(fallback);
    return r.ok ? { ok: true, opened: "website" } : r;
  }
  return { ok: false, error: `couldn't find an app or folder called ${name}` };
}

// --- Developer mode: arbitrary shell (gated) -------------------------------
// Two static gates. Neither can PROVE a command is safe — that's undecidable —
// so the design is: (1) refuse anything that defeats inspection, so the command
// the user confirmed is the command that runs; (2) veto the catastrophic &
// irreversible. The real safety is the human reading the literal command in the
// browser and tapping Run. This is a guard against the model's mistakes, not an
// adversary; do not treat it as a sandbox that makes any input safe.

// Gate 1 — refuse things that hide what the command actually does, so showing
// the command text to the user isn't a lie.
const SHELL_OPAQUE = [
  /(^|\s)-e(nc(odedcommand)?)?\b/i, // -e / -enc / -encodedcommand (base64)
  /\biex\b|\binvoke-expression\b/i, // run a string as code
  /\b(irm|iwr|invoke-webrequest|invoke-restmethod|wget|curl)\b/i, // fetch...
  /downloadstring|downloadfile|frombase64string/i, // ...and run/decode
  /\bstart-process\b.*\b(powershell|pwsh|cmd)\b/i, // re-shell to escape the gate
  /[`\u0000]/, // backtick obfuscation or null bytes (spaces are fine)
];
// Gate 2 — veto destructive / irreversible / privileged operations.
const SHELL_DESTRUCTIVE = [
  /\b(remove-item|ri|rm|del|erase|rmdir|rd)\b/i, // delete files/dirs
  /\b(clear-content|clc|set-content|sc|add-content|ac|out-file)\b/i, // overwrite
  /\b(format-volume|format|diskpart|cipher|vssadmin|bcdedit|fsutil)\b/i, // disk
  /\b(stop-computer|restart-computer|shutdown|logoff|stop-process|spps|kill|taskkill)\b/i,
  /\b(set-service|stop-service|new-service|sc\.exe|schtasks|register-scheduledtask)\b/i,
  /\bset-executionpolicy\b/i,
  /\b(net\s+user|net\s+localgroup|new-localuser|add-localgroupmember)\b/i,
  /\b(set-mppreference|add-mppreference)\b/i, // touching Defender
  /\b(set-itemproperty|new-itemproperty|remove-itemproperty|reg(\.exe)?\s+(add|delete))\b/i,
  /hk(lm|cu|cr|u|cc):|hkey_/i, // registry hives
  /\bsetx\b|\[environment\]::set/i, // persist env vars
  /::(delete|writealltext|writeallbytes|move|create)|\.delete\s*\(/i, // .NET file ops
  /[>]{1,2}/, // redirection can clobber files
];

function inspectShell(command) {
  if (typeof command !== "string") return { ok: false, error: "command must be a string" };
  const cmd = command.trim();
  if (!cmd) return { ok: false, error: "empty command" };
  if (cmd.length > 2000) return { ok: false, error: "command too long" };
  for (const re of SHELL_OPAQUE) {
    if (re.test(cmd))
      return { ok: false, error: "refused: command hides what it does (encoded/remote/obfuscated). Keep it a plain, readable command." };
  }
  for (const re of SHELL_DESTRUCTIVE) {
    if (re.test(cmd))
      return { ok: false, error: "refused: command looks destructive or privileged (delete/overwrite/registry/power/service). Not allowed in developer mode." };
  }
  return { ok: true, cmd };
}

// Run a vetted command non-interactively with a hard timeout, capturing output.
function runShell(command, cwd) {
  return new Promise((resolve) => {
    const check = inspectShell(command);
    if (!check.ok) return resolve({ ok: false, error: check.error });
    if (platform !== "win32")
      return resolve({ ok: false, error: "shell mode is Windows/PowerShell only" });

    // Run in the caller's working folder when one is given and exists; otherwise
    // the command would run in the bridge's own dir (e.g. the PersonalAI repo),
    // which is how scaffolders/builds end up polluting the wrong project.
    const spawnOpts = { windowsHide: true };
    if (cwd && typeof cwd === "string" && existsSync(cwd)) spawnOpts.cwd = cwd;
    console.log(`[bridge] run_shell${spawnOpts.cwd ? ` @${spawnOpts.cwd}` : ""}: ${check.cmd}`);
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", check.cmd],
      spawnOpts
    );
    let out = "";
    let err = "";
    let killed = false;
    const cap = (s) => (out + err).length < SHELL_MAX_OUTPUT;
    child.stdout.on("data", (d) => { if (cap()) out += d; });
    child.stderr.on("data", (d) => { if (cap()) err += d; });
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, SHELL_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed)
        return resolve({ ok: false, error: `timed out after ${SHELL_TIMEOUT_MS / 1000}s`, stdout: out.slice(0, SHELL_MAX_OUTPUT) });
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: out.slice(0, SHELL_MAX_OUTPUT),
        stderr: err.slice(0, SHELL_MAX_OUTPUT),
      });
    });
  });
}

// --- Local AI helpers ------------------------------------------------------
// Probe both local backends with a short timeout so /local/status is snappy
// even when one is down (connection refused is near-instant; a hung port is
// the only slow case, which the AbortController caps).
async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeLocal() {
  const out = { fllm: false, models: [] };
  try {
    const res = await fetchWithTimeout(`${resolveFllm().url}/v1/models`, { headers: fllmHeaders() }, 3000);
    if (res.ok) {
      out.fllm = true;
      const data = await res.json().catch(() => ({}));
      out.models = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
    }
  } catch {
    /* freellmapi down */
  }
  return out;
}

// Resolve the hermes executable (env override, else PATH lookup).
function resolveHermesBin() {
  if (HERMES_BIN_ENV) return HERMES_BIN_ENV;
  try {
    const r = spawnSync(platform === "win32" ? "where" : "which", ["hermes"], {
      encoding: "utf8",
      timeout: 4000,
    });
    if (r.status === 0) {
      const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
  } catch {
    /* not on PATH */
  }
  return "hermes";
}

// Is the Hermes Agent CLI installed? Probe via where/which (an .exe itself, so
// it spawns even when `hermes` is a .cmd shim).
function hermesAvailable() {
  if (HERMES_BIN_ENV) return existsSync(HERMES_BIN_ENV);
  try {
    const r = spawnSync(platform === "win32" ? "where" : "which", ["hermes"], { timeout: 4000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// The id of the rolling JARVIS↔Hermes conversation. `hermes -z --resume <id>`
// loads the prior session's history but writes a NEW session each turn, so after
// every turn we capture the freshly-created id and resume THAT next time — this
// chains context forward across turns. Reset to null (POST {reset:true}, or a
// bridge restart) starts a fresh conversation.
let hermesSession = null;

// Post-turn bookkeeping (session-id capture, tool trace, activity log, memory
// mirror) each costs a fresh `hermes` subprocess cold-start. None of it is
// needed to ANSWER the user, so we never block the reply on it: hermesRun
// resolves the moment Hermes prints, then schedules this work to run after the
// HTTP response has flushed. `pendingCapture` is the in-flight promise; the NEXT
// turn awaits it before spawning, so the resumed-session id is current by then.
let pendingCapture = null;

// `hermes config path` is stable for the life of the process, so resolve it once
// and cache it (was previously re-spawned on every turn via mirrorHermesMemory).
let configDirCache; // undefined = not resolved yet; string|null after.

// Newest session id from `hermes sessions list` (top data row). The just-finished
// `-z` turn is always the most recent session, so this recovers the id Hermes
// generated for the turn we just ran.
function hermesLatestSessionId() {
  try {
    const bin = resolveHermesBin();
    const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const file = useCmd ? "cmd" : bin;
    const sub = ["sessions", "list"];
    const args = useCmd ? ["/c", bin, ...sub] : sub;
    const r = spawnSync(file, args, { timeout: 10_000, encoding: "utf8", windowsHide: true, cwd: HERMES_CWD });
    for (const line of `${r.stdout || ""}`.split(/\r?\n/)) {
      // Data rows end with the id; ids look like 20260610_235132_425ef0.
      const m = line.match(/(\d{8}_\d{6}_[0-9a-f]+)\s*$/);
      if (m) return m[1];
    }
  } catch { /* best-effort */ }
  return null;
}

// Export ONE session as JSON and pull out the model + the tool calls made on the
// LAST turn (everything after the final user message), so JARVIS can show what
// Hermes actually did instead of just the final text.
function hermesSessionDetail(id) {
  const detail = { sessionId: id, model: "", tools: [] };
  if (!id) return detail;
  try {
    const bin = resolveHermesBin();
    const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const file = useCmd ? "cmd" : bin;
    const sub = ["sessions", "export", "--session-id", id, "-"];
    const args = useCmd ? ["/c", bin, ...sub] : sub;
    const r = spawnSync(file, args, { timeout: 10_000, encoding: "utf8", windowsHide: true, cwd: HERMES_CWD, maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(`${r.stdout || ""}`.trim());
    detail.model = String(data.model || "");
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    // Only this turn: messages after the last user message.
    let start = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") { start = i + 1; break; }
    }
    for (const msg of msgs.slice(start)) {
      const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      for (const c of calls) {
        const name = c?.function?.name || c?.name;
        if (!name) continue;
        let args = c?.function?.arguments ?? c?.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep string */ } }
        detail.tools.push({ name, args: args ?? {} });
      }
    }
  } catch { /* best-effort — no trace is fine */ }
  return detail;
}

// Append a human-readable turn record to `Activity.md` in Hermes' working folder
// (the Obsidian "Hermes" vault), so the user can see — outside the terminal —
// what was asked, which tools ran, and the reply. Newest entries at the bottom.
function logHermesActivity(text, detail, reply) {
  try {
    if (!HERMES_CWD || !existsSync(HERMES_CWD)) return;
    const stamp = new Date().toLocaleString("en-SG", { hour12: false });
    const toolLine = detail.tools.length
      ? detail.tools
          .map((t) => {
            const a = t.args && typeof t.args === "object" ? Object.values(t.args)[0] : t.args;
            const arg = a != null ? String(a).slice(0, 60) : "";
            return arg ? `${t.name}(${arg})` : t.name;
          })
          .join(", ")
      : "none";
    const snippet = reply.replace(/\s+/g, " ").trim().slice(0, 4000);
    const entry =
      `\n## ${stamp} · turn ${detail.sessionId || "?"}\n` +
      `- **You:** ${text.replace(/\s+/g, " ").trim().slice(0, 200)}\n` +
      `- **Tools:** ${toolLine}\n` +
      `- **Model:** ${detail.model || "?"}\n` +
      `- **Reply:** ${snippet}\n`;
    const file = join(HERMES_CWD, "Activity.md");
    if (!existsSync(file)) {
      writeFileSync(
        file,
        "# Hermes Activity Log\n\nAuto-written by the JARVIS bridge after every local turn: " +
          "what you asked, which tools Hermes ran, and its reply. Newest at the bottom.\n",
        "utf8"
      );
    }
    appendFileSync(file, entry, "utf8");
  } catch {
    /* logging is best-effort — never block a turn on it */
  }
}

// Hermes' config dir (parent of config.yaml), discovered via `hermes config
// path` so we don't hardcode the install location. The built-in memory store
// (USER.md / MEMORY.md) lives in `<configDir>/memories/`.
function hermesConfigDir() {
  if (configDirCache !== undefined) return configDirCache;
  configDirCache = null; // cache "not found" too, so a miss isn't re-spawned each turn
  try {
    const bin = resolveHermesBin();
    const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const file = useCmd ? "cmd" : bin;
    const sub = ["config", "path"];
    const args = useCmd ? ["/c", bin, ...sub] : sub;
    const r = spawnSync(file, args, { timeout: 8000, encoding: "utf8", windowsHide: true });
    const p = `${r.stdout || ""}`.trim().split(/\r?\n/)[0];
    if (p) configDirCache = dirname(p);
  } catch { /* best-effort */ }
  return configDirCache;
}

// The model Hermes is configured to run (config.yaml `model.default`), so the web
// app can show it on the routing HUD the instant a local turn starts — `hermes -z`
// is buffered, so without this the deck has nothing to show until the turn ends.
// Cached: config.yaml rarely changes and re-reading it per /local/status poll is
// wasteful. Returns "" when unknown (config missing/unreadable).
let hermesModelCache;
function hermesConfiguredModel() {
  if (hermesModelCache !== undefined) return hermesModelCache;
  hermesModelCache = "";
  try {
    const cfgDir = hermesConfigDir();
    if (!cfgDir) return hermesModelCache;
    const text = readFileSync(join(cfgDir, "config.yaml"), "utf8");
    const lines = text.split(/\r?\n/);
    let inModel = false;
    for (const line of lines) {
      if (/^model:\s*$/.test(line)) { inModel = true; continue; }
      if (inModel) {
        if (/^\S/.test(line)) break; // left the model: block (dedent to col 0)
        const m = /^\s+default:\s*(.+?)\s*$/.exec(line);
        if (m) { hermesModelCache = m[1].replace(/^['"]|['"]$/g, ""); break; }
      }
    }
  } catch { /* best-effort */ }
  return hermesModelCache;
}

// Two-way mirror of Hermes' internal memory (the §-delimited USER.md/MEMORY.md
// the `memory` tool writes) and a clean MEMORY.md in the Obsidian vault folder,
// so the user can SEE — and PRUNE — what Hermes remembers without digging into
// .hermes.
//
//   Hermes → vault: each turn we re-render the vault file from the real store, so
//                   anything Hermes just learned shows up.
//   vault → Hermes: if you DELETE (or edit) a line in the vault file, that change
//                   is written back to the real store so it actually sticks —
//                   previously the vault was overwrite-only and your edits
//                   reverted on the next turn.
//
// The diff is anchored on `lastMirror` — the normalized entries we last wrote to
// the vault. An entry we last mirrored that's now MISSING from the vault means
// you removed it → drop it from the store. Entries Hermes added since (in the
// store but never mirrored) are kept, so a fresh fact is never lost to writeback.
const memNorm = (s) => s.replace(/\s+/g, " ").trim();
// Snapshot of the entries we last rendered to the vault, the anchor the writeback
// diff uses ("shown last time but gone now" = user deleted it). PERSISTED to disk
// so it survives a bridge restart — otherwise the first tick after every restart
// has no anchor and silently reverts the user's pending deletions.
const MIRROR_SNAPSHOT_FILE = join(HERMES_CWD, ".jarvis-mirror-snapshot.json");
let lastMirror = null; // { USER: Set<normalized>, MEMORY: Set<normalized> } | null
try {
  if (existsSync(MIRROR_SNAPSHOT_FILE)) {
    const s = JSON.parse(readFileSync(MIRROR_SNAPSHOT_FILE, "utf8"));
    lastMirror = { USER: new Set(s.USER || []), MEMORY: new Set(s.MEMORY || []) };
  }
} catch { /* corrupt/missing → null (boot becomes store-authoritative, as before) */ }

// Pull the user-visible lines out of one "## …" section of the vault MEMORY.md.
function parseVaultSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const out = new Set();
  let inSec = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inSec = line.includes(heading); continue; }
    if (!inSec) continue;
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = memNorm(m[1]);
    if (v && v !== "(nothing saved yet)") out.add(v);
  }
  return out;
}

function mirrorHermesMemory() {
  try {
    if (!HERMES_CWD || !existsSync(HERMES_CWD)) return;
    const cfgDir = hermesConfigDir();
    if (!cfgDir) return;
    const memDir = join(cfgDir, "memories");
    const vaultFile = join(HERMES_CWD, "MEMORY.md");

    // Raw §-delimited entries (originals preserved verbatim for writeback).
    const rawEntries = (name) => {
      const p = join(memDir, name);
      if (!existsSync(p)) return null; // null = file absent, don't write one back
      return readFileSync(p, "utf8").split(/\r?\n?§\r?\n?/).map((s) => s.trim()).filter(Boolean);
    };

    // First tick with no persisted snapshot: anchor on the CURRENT store so the
    // very first deletion still sticks. Hermes only writes memory during a turn
    // (which goes through the bridge), so the store can't gain facts while we're
    // off — making the live store a safe stand-in for "what was last shown".
    if (!lastMirror && existsSync(vaultFile)) {
      lastMirror = {
        USER: new Set((rawEntries("USER.md") || []).map(memNorm).filter(Boolean)),
        MEMORY: new Set((rawEntries("MEMORY.md") || []).map(memNorm).filter(Boolean)),
      };
    }

    // vault → Hermes: apply the user's deletions to the real store before we
    // re-render, so a removed line doesn't reappear on this very tick.
    if (lastMirror && existsSync(vaultFile)) {
      const vault = readFileSync(vaultFile, "utf8");
      const kept = {
        "USER.md": parseVaultSection(vault, "USER.md"),
        "MEMORY.md": parseVaultSection(vault, "MEMORY.md"),
      };
      for (const [name, key] of [["USER.md", "USER"], ["MEMORY.md", "MEMORY"]]) {
        const entries = rawEntries(name);
        if (!entries) continue;
        const inVault = kept[name];
        const prev = lastMirror[key] || new Set();
        // Keep an entry unless the user deleted it: it was shown last time (prev)
        // and is now gone from the vault. Anything not previously mirrored stays.
        const next = entries.filter((e) => {
          const n = memNorm(e);
          return inVault.has(n) || !prev.has(n);
        });
        if (next.length !== entries.length) {
          writeFileSync(join(memDir, name), next.join("\n§\n") + (next.length ? "\n" : ""), "utf8");
        }
      }
    }

    // Hermes → vault: re-render from the (now-pruned) real store.
    const norm = (name) => (rawEntries(name) || []).map(memNorm).filter(Boolean);
    const userArr = norm("USER.md");
    const notesArr = norm("MEMORY.md");
    const fmt = (arr) => (arr.length ? arr.map((s) => `- ${s}`).join("\n") : "- (nothing saved yet)");
    const body =
      "# Hermes memory (live)\n\n" +
      "Auto-synced by the JARVIS bridge with Hermes' memory store after every turn.\n" +
      'To add a durable fact, tell Hermes "remember …". To FORGET one, delete its line ' +
      "here — the change is written back to Hermes' store on the next turn.\n\n" +
      `## About you (USER.md)\n${fmt(userArr)}\n\n` +
      `## Notes (MEMORY.md)\n${fmt(notesArr)}\n`;
    writeFileSync(vaultFile, body, "utf8");
    lastMirror = { USER: new Set(userArr), MEMORY: new Set(notesArr) };
    try { writeFileSync(MIRROR_SNAPSHOT_FILE, JSON.stringify({ USER: userArr, MEMORY: notesArr }), "utf8"); }
    catch { /* snapshot is an optimization — losing it just reverts to boot-authoritative */ }
  } catch {
    /* best-effort — never block a turn on it */
  }
}

// Carry-between-ticks state for the Model Caps mirror (see MODEL_CAPS_FILE). The
// file is always authoritative for caps, so no first-run/mtime bookkeeping — we
// only remember the last body we wrote to avoid rewriting an unchanged file.
let lastCapsBody = null;

// Same idea for the Router Cooldowns mirror (see ROUTER_COOLDOWNS_FILE): the file
// is your control surface, so it always wins; we just remember the last body to
// avoid rewriting an unchanged file.
let lastCooldownsBody = null;

// ── Model Caps mirror (two-way, freellmapi DB ⇄ Obsidian) ───────────────────
const fmtCap = (n) => (n == null ? "—" : String(n));
// Read one cap value from the file. undefined = field absent (don't touch it);
// null = "—"/blank (clear the cap); a number otherwise. Commas/underscores ok.
function parseCapVal(s) {
  if (s == null) return undefined;
  const t = String(s).trim();
  if (t === "" || t === "—" || t === "-") return null;
  const n = Number(t.replace(/[,_\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// Render every freellmapi model grouped by provider, one editable line each.
function renderCapsBody(models) {
  const byPlat = new Map();
  for (const m of models) {
    if (!byPlat.has(m.platform)) byPlat.set(m.platform, []);
    byPlat.get(m.platform).push(m);
  }
  return [...byPlat.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([plat, list]) => {
      const lines = list
        .map((m) => `- \`${m.modelId}\` — tpd ${fmtCap(m.tpdLimit)} · rpd ${fmtCap(m.rpdLimit)} · rpm ${fmtCap(m.rpmLimit)}`)
        .join("\n");
      return `## ${plat}\n\n${lines}\n`;
    })
    .join("\n");
}

// Parse the file back into a Map keyed "platform\0modelId" → {tpd?,rpd?,rpm?}.
function parseCapsEdits(text) {
  const out = new Map();
  let plat = null;
  const platRe = /^##\s+(.+?)\s*$/;
  const lineRe = /^-\s+`([^`]+)`\s*—\s*(.*)$/;
  for (const raw of text.split(/\r?\n/)) {
    const pm = platRe.exec(raw);
    if (pm) { plat = pm[1].trim(); continue; }
    if (!plat) continue;
    const lm = lineRe.exec(raw);
    if (!lm) continue;
    const rest = lm[2];
    const grab = (label) => {
      const r = new RegExp(label + "\\s+([\\d.,_]+|—|-)", "i").exec(rest);
      return r ? r[1] : null;
    };
    const rec = {};
    const tpd = parseCapVal(grab("tpd"));
    const rpd = parseCapVal(grab("rpd"));
    const rpm = parseCapVal(grab("rpm"));
    if (tpd !== undefined) rec.tpd = tpd;
    if (rpd !== undefined) rec.rpd = rpd;
    if (rpm !== undefined) rec.rpm = rpm;
    out.set(plat + "\u0000" + lm[1], rec);
  }
  return out;
}

// One sync tick: if the file was edited, write changed caps into freeapi.db, then
// (re)render the file from the DB. freellmapi being offline just skips the tick.
async function syncModelCaps() {
  if (!MODEL_SYNC) return;
  if (!existsSync(JARVIS_VAULT)) return;
  try {
    const data = await readFllmDb();
    if (!data || !Array.isArray(data.models) || data.models.length === 0) return;
    let models = data.models;

    // The file is YOUR control surface for caps, so it always wins: whenever it
    // exists and a value differs from the DB, push it into freeapi.db — INCLUDING
    // on the first tick / right after a restart. (The old first-run-authoritative
    // skip is exactly what reset edits made while the bridge was off.) Re-applying
    // our own last render is a no-op — values already match → no diff, no write —
    // so there's no churn and no need for an mtime guard.
    if (existsSync(MODEL_CAPS_FILE)) {
      const edits = parseCapsEdits(readFileSync(MODEL_CAPS_FILE, "utf8"));
      const updates = [];
      for (const m of models) {
        const e = edits.get(m.platform + "\u0000" + m.modelId);
        if (!e) continue;
        const u = { platform: m.platform, modelId: m.modelId };
        let diff = false;
        if ("tpd" in e && e.tpd !== (m.tpdLimit ?? null)) { u.tpd = e.tpd; diff = true; }
        if ("rpd" in e && e.rpd !== (m.rpdLimit ?? null)) { u.rpd = e.rpd; diff = true; }
        if ("rpm" in e && e.rpm !== (m.rpmLimit ?? null)) { u.rpm = e.rpm; diff = true; }
        if (diff) updates.push(u);
      }
      if (updates.length) {
        await writeFllmCaps(updates);
        const fresh = await readFllmDb(); // reflect what actually landed
        if (fresh && Array.isArray(fresh.models) && fresh.models.length) models = fresh.models;
      }
    }

    const body = renderCapsBody(models);
    // Skip the rewrite only when nothing changed AND the file already exists.
    if (body === lastCapsBody && existsSync(MODEL_CAPS_FILE)) return;
    const header =
      "# JARVIS — Model Caps\n\n" +
      "_Auto-synced by the bridge from freellmapi's database. Edit a number and save; the bridge writes it back within a minute (while the bridge is running)._\n\n" +
      "Each model's **daily token budget** on the Pipeline board = `tpd` × the number of keys/accounts for that provider. " +
      "Set `tpd` (tokens/day), `rpd` (requests/day) or `rpm` (requests/min) to a number, or `—` for no cap. " +
      "A model showing `tpd —` is exactly why the board prints \"—\" instead of a budget for it.\n\n" +
      `Last synced: ${new Date().toLocaleString("en-SG", { hour12: false })}\n\n`;
    writeFileSync(MODEL_CAPS_FILE, header + body, "utf8");
    lastCapsBody = body;
  } catch {
    /* freellmapi offline / vault missing / transient — retry next tick */
  }
}

// ── Router Cooldowns mirror (two-way, app DB ⇄ Obsidian) ────────────────────
// Render minutes (friendlier than ms); accept decimals like `1440` or `30`.
const msToMin = (ms) => Math.round(Number(ms) / 60_000);
function parseMinToMs(s) {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/[,_\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60_000) : undefined;
}

function renderCooldownsBody(cfg) {
  return (
    `- **rate limit** (429 / 413) — \`${msToMin(cfg.cooldownRateLimitMs)}\` min\n` +
    `- **client error** (4xx, e.g. 400) — \`${msToMin(cfg.cooldownClientErrorMs)}\` min\n`
  );
}

const COOLDOWN_FAILURE_MARKER = "## Recent router failures";
function preserveCooldownFailureLog(text) {
  const i = text.indexOf(COOLDOWN_FAILURE_MARKER);
  return i >= 0 ? text.slice(i).trimEnd() : `${COOLDOWN_FAILURE_MARKER}\n\n`;
}

// Pull the two editable minute values back out of the file.
function parseCooldownsEdits(text) {
  const out = {};
  const grab = (label) => {
    const r = new RegExp(`\\*\\*${label}\\*\\*[^\`]*\`([\\d.,_]+)\``, "i").exec(text);
    return r ? parseMinToMs(r[1]) : undefined;
  };
  const rl = grab("rate limit");
  const ce = grab("client error");
  if (rl !== undefined) out.cooldownRateLimitMs = rl;
  if (ce !== undefined) out.cooldownClientErrorMs = ce;
  return out;
}

async function fetchRouterConfig() {
  const res = await fetchWithTimeout(`${JARVIS_URL}/api/router-config`, {}, 8000);
  if (!res.ok) throw new Error(`GET /api/router-config ${res.status}`);
  return res.json(); // { config, limits }
}

// One sync tick: if the file was edited, push the minute values into the app's
// router config, then (re)render the file from the app's truth. App offline /
// vault missing just skips the tick quietly.
async function syncRouterCooldowns() {
  if (!MODEL_SYNC) return;
  if (!existsSync(JARVIS_VAULT)) return;
  try {
    let { config } = await fetchRouterConfig();
    if (!config) return;

    // The file is your control surface, so it always wins: when it exists and a
    // value differs from the app, POST it. Re-applying our own last render is a
    // no-op (values match → no diff → no write), so no mtime guard is needed.
    if (existsSync(ROUTER_COOLDOWNS_FILE)) {
      const edits = parseCooldownsEdits(readFileSync(ROUTER_COOLDOWNS_FILE, "utf8"));
      const payload = {};
      if (edits.cooldownRateLimitMs !== undefined && edits.cooldownRateLimitMs !== config.cooldownRateLimitMs)
        payload.cooldownRateLimitMs = edits.cooldownRateLimitMs;
      if (edits.cooldownClientErrorMs !== undefined && edits.cooldownClientErrorMs !== config.cooldownClientErrorMs)
        payload.cooldownClientErrorMs = edits.cooldownClientErrorMs;
      if (Object.keys(payload).length) {
        const res = await fetchWithTimeout(
          `${JARVIS_URL}/api/router-config`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
          8000,
        );
        if (res.ok) {
          const j = await res.json();
          if (j?.config) config = j.config; // reflect what actually landed (clamped)
        }
      }
    }

    const body = renderCooldownsBody(config);
    const preservedLog = existsSync(ROUTER_COOLDOWNS_FILE)
      ? preserveCooldownFailureLog(readFileSync(ROUTER_COOLDOWNS_FILE, "utf8"))
      : `${COOLDOWN_FAILURE_MARKER}\n\n`;
    if (body === lastCooldownsBody && existsSync(ROUTER_COOLDOWNS_FILE)) return;
    const header =
      "# JARVIS — Router Cooldowns\n\n" +
      "_Auto-synced by the bridge from the app's router config. Edit a number (in **minutes**) and save; the bridge writes it back within a minute (while the bridge is running)._\n\n" +
      "When a model fails, the router parks that **model id** for this long before it'll be re-picked, so it stops rotating to the same dead model on another provider/key and wasting time:\n\n" +
      "- **rate limit** = the model got 429 (or 413 TPM) — throttled, give it a rest.\n" +
      "- **client error** = the model got a 4xx like 400 — the model is rejecting requests, sideline it for longer.\n\n" +
      `Last synced: ${new Date().toLocaleString("en-SG", { hour12: false })}\n\n`;
    writeFileSync(ROUTER_COOLDOWNS_FILE, `${header}${body}\n\n${preservedLog}\n`, "utf8");
    lastCooldownsBody = body;
  } catch {
    /* app offline / vault missing / transient — retry next tick */
  }
}

// Pull the last few turns out of Activity.md as a compact context block, used to
// re-seed Hermes after its session chain is lost. Parses the "## …" turn blocks
// the activity logger writes and keeps only the user line + reply, truncated.
function recentActivityContext(maxTurns) {
  try {
    if (!HERMES_CWD) return "";
    const file = join(HERMES_CWD, "Activity.md");
    if (!existsSync(file)) return "";
    const blocks = readFileSync(file, "utf8").split(/\r?\n##\s+/).slice(1); // drop file header
    const lines = [];
    for (const b of blocks.slice(-maxTurns)) {
      const you = (b.match(/\*\*You:\*\*\s*(.+)/) || [])[1] || "";
      const reply = (b.match(/\*\*Reply:\*\*\s*(.+)/) || [])[1] || "";
      if (you.trim() || reply.trim())
        lines.push(`- User: "${you.trim().slice(0, 200)}" — you answered: "${reply.trim().slice(0, 200)}"`);
    }
    if (!lines.length) return "";
    return "Recent conversation, for continuity (don't repeat it, just stay consistent):\n" +
      lines.join("\n") + "\n\n";
  } catch {
    return "";
  }
}

// Run ONE Hermes turn non-interactively: `hermes -z "<text>"` → final reply on
// stdout. Text is passed as a discrete argv element (no shell), so there's no
// command injection from the user's utterance. We resume the rolling session so
// Hermes keeps context across turns, then capture the new session's id + tool
// trace to return alongside the reply.
// Run the post-turn bookkeeping AFTER the reply has gone out. Deferred with
// setImmediate so the HTTP response flushes first (these calls are spawnSync and
// would otherwise block the event loop before the socket write runs). Stored in
// `pendingCapture` so the next turn can await it — that keeps `hermesSession`
// current for `--resume` without ever making the user wait on it.
function scheduleCapture(text, reply) {
  pendingCapture = new Promise((resolve) => {
    setImmediate(() => {
      try {
        const id = hermesLatestSessionId();
        if (id) hermesSession = id;
        const detail = hermesSessionDetail(id);
        logHermesActivity(text, detail, reply); // human-readable Obsidian log
        mirrorHermesMemory(); // surface Hermes' real memory in the vault MEMORY.md
      } catch { /* best-effort — bookkeeping never blocks or breaks a turn */ }
      resolve();
    });
  });
}

// Locate a Chromium-family browser that supports --remote-debugging-port.
function findChromeBin() {
  if (CHROME_BIN_ENV) return existsSync(CHROME_BIN_ENV) ? CHROME_BIN_ENV : null;
  if (platform !== "win32") return null; // Windows-only launcher for now
  const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const lad = process.env.LOCALAPPDATA || "";
  const candidates = [
    join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    lad ? join(lad, "Google\\Chrome\\Application\\chrome.exe") : "",
    join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
    join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// Is a CDP endpoint answering on the debug port?
async function cdpAlive() {
  try {
    const r = await fetchWithTimeout(`http://127.0.0.1:${HERMES_CDP_PORT}/json/version`, {}, 1500);
    return r.ok;
  } catch {
    return false;
  }
}

let debugChromeProc = null;

// "Is the JARVIS tab still open?" liveness. The web app polls /local/status
// every ~15s, so a fresh timestamp there means a tab is open; when the user
// closes the tab the polling stops. If it goes quiet for TAB_IDLE_MS we close
// the visible Hermes Chrome we launched — so it shuts when you close the tab,
// but a quick refresh (polling resumes in ~1s) keeps it open. Set
// BRIDGE_CLOSE_BROWSER_ON_TAB=0 to leave Chrome running regardless.
const CLOSE_BROWSER_ON_TAB = !/^(0|false|no|off)$/i.test(process.env.BRIDGE_CLOSE_BROWSER_ON_TAB || "1");
const TAB_IDLE_MS = Number(process.env.BRIDGE_TAB_IDLE_MS) || 45_000;
let lastTabPing = 0;

function closeDebugChromeIfTabGone() {
  if (!CLOSE_BROWSER_ON_TAB || !debugChromeProc || !lastTabPing) return;
  if (Date.now() - lastTabPing <= TAB_IDLE_MS) return;
  console.log("[bridge] JARVIS tab closed — closing the Hermes browser");
  try { debugChromeProc.kill(); } catch { /* already gone */ }
  debugChromeProc = null;
  lastTabPing = 0;
}

// Ensure a visible, debuggable Chrome is running; return its CDP base URL, or
// null if we couldn't start one (caller then falls back to the headless path).
// Reuses an already-listening port — ours from a prior turn, or one the user
// launched themselves — so we never stack up Chrome instances.
async function ensureDebugChrome() {
  const url = `http://127.0.0.1:${HERMES_CDP_PORT}`;
  if (await cdpAlive()) return url;
  const bin = findChromeBin();
  if (!bin) {
    console.error("[bridge] hermes CDP: no Chrome/Edge found — set BRIDGE_CHROME_BIN or use BRIDGE_HERMES_CDP=0");
    return null;
  }
  try { mkdirSync(HERMES_CHROME_PROFILE, { recursive: true }); } catch { /* ignore */ }
  try {
    debugChromeProc = spawn(bin, [
      `--remote-debugging-port=${HERMES_CDP_PORT}`,
      `--user-data-dir=${HERMES_CHROME_PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Anti-bot-detection: keep navigator.webdriver false and drop the
      // "Chrome is being controlled by automated test software" banner, so
      // sites with bot protection (common on .edu.sg / Cloudflare-fronted
      // pages — the sp.edu.sg "client-side blocking" failure) don't refuse a
      // plain navigate. This only affects the bridge-owned profile.
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
      "--start-maximized",
      "about:blank",
    ], { stdio: "ignore", windowsHide: false });
    debugChromeProc.on("error", (e) => { console.error("[bridge] debug Chrome error:", e.message); debugChromeProc = null; });
    debugChromeProc.on("exit", () => { debugChromeProc = null; });
  } catch (e) {
    console.error("[bridge] couldn't launch debug Chrome:", e.message);
    return null;
  }
  for (let i = 0; i < 40; i++) {
    if (await cdpAlive()) { console.log(`[bridge] hermes browser: visible Chrome on ${url}`); return url; }
    await sleep(200);
  }
  console.error("[bridge] debug Chrome didn't open its CDP port in time");
  return null;
}

// Build the environment for a `hermes -z` turn. Prefer the CDP path (visible,
// persistent browser the bridge owns); fall back to the headless agent-browser
// daemon with a long idle timeout if Chrome can't be launched.
async function buildHermesEnv() {
  const env = { ...process.env };
  if (HERMES_CDP) {
    const cdp = await ensureDebugChrome();
    if (cdp) { env.BROWSER_CDP_URL = cdp; return env; }
    // else: fall through to the headless path below
  }
  if (HERMES_HEADED) env.AGENT_BROWSER_HEADED = "1";
  env.BROWSER_INACTIVITY_TIMEOUT = String(Math.round(HERMES_BROWSER_IDLE_MS / 1000));
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(HERMES_BROWSER_IDLE_MS);
  return env;
}

async function hermesRun(text, { reset = false } = {}) {
  // Make sure the previous turn's session-id capture has landed before we resume,
  // so cross-turn memory chains correctly. This wait overlaps the user's next
  // utterance/STT, not the reply, so it costs no perceived latency.
  if (pendingCapture) { try { await pendingCapture; } catch { /* ignore */ } pendingCapture = null; }
  if (reset) hermesSession = null;
  const childEnv = await buildHermesEnv();
  return new Promise((resolve) => {
    const bin = resolveHermesBin();
    const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const file = useCmd ? "cmd" : bin;
    // Compact recap of the last N turns from Activity.md = the short-term memory.
    // Predictable size, no giant resumed payload, and stable across model
    // rotation (so prompt caching can hit). --resume is only added when the user
    // opted back in via BRIDGE_HERMES_RESUME=1.
    const seed = HERMES_SEED ? recentActivityContext(hermesSeedTurns) : "";
    const sendText = seed ? `${seed}Now the user says: ${text}` : text;
    const zArgs = ["-z", sendText];
    // Scope the per-invocation toolset to ONLY the enabled toolsets, so Hermes'
    // prompt carries just the tools the user checked (unchecked ones are dropped
    // from the prompt, not just refused). Empty/unknown → omit, keep config default.
    const toolsetsCsv = getEnabledToolsetsCsv();
    if (toolsetsCsv) zArgs.push("-t", toolsetsCsv);
    const useResume = HERMES_RESUME && hermesSession;
    if (useResume) zArgs.push("--resume", hermesSession);
    const args = useCmd ? ["/c", bin, ...zArgs] : zArgs;
    console.log(`[bridge] hermes -z (${text.length} chars)${useResume ? ` resume ${hermesSession}` : ""}${toolsetsCsv ? ` -t ${toolsetsCsv}` : ""} seed=${seed ? hermesSeedTurns : 0}`);
    let child;
    const spawnOpts = { windowsHide: true, env: childEnv };
    if (HERMES_CWD && existsSync(HERMES_CWD)) spawnOpts.cwd = HERMES_CWD;
    try {
      child = spawn(file, args, spawnOpts);
    } catch (e) {
      return resolve({ ok: false, error: `couldn't start hermes: ${e.message}` });
    }
    let out = "";
    let err = "";
    let done = false;     // promise settled (reply sent or error)
    let captured = false; // scheduleCapture already run (tie to real close)
    let idleTimer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve(r);
    };
    // Send the reply the instant stdout has produced an answer and gone quiet,
    // rather than waiting for the process to fully exit (teardown tail). The
    // process is left running so its own bookkeeping completes; scheduleCapture
    // still fires on the real `close` below so the session-id/Activity.md log
    // reflect the FINISHED run, not a half-done one.
    const flushReply = () => {
      const reply = out.trim();
      if (done || !reply) return;
      child.unref?.(); // don't let the lingering process hold the event loop
      finish({ ok: true, reply, sessionId: hermesSession, model: "", tools: [] });
    };
    const bumpIdle = () => {
      if (!HERMES_IDLE_FLUSH_MS || done) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(flushReply, HERMES_IDLE_FLUSH_MS);
    };
    child.stdout.on("data", (d) => { if (out.length < HERMES_MAX_OUTPUT) out += d; bumpIdle(); });
    child.stderr.on("data", (d) => { if (err.length < HERMES_MAX_OUTPUT) err += d; });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "Hermes timed out." });
    }, HERMES_TIMEOUT_MS);
    child.on("error", (e) => finish({ ok: false, error: `Hermes failed: ${e.message}` }));
    child.on("close", (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      const reply = out.trim();
      // Prefer any produced reply; some agent CLIs exit non-zero yet still answer.
      if (reply) {
        // Bookkeeping (session-id capture, tool trace, Activity.md log, memory
        // mirror) each cost another `hermes` subprocess cold-start, so they run
        // after the turn via scheduleCapture instead of blocking it — and only
        // once the process has actually closed, so they see the finished run.
        if (!captured) { captured = true; scheduleCapture(text, reply); }
        // If the idle flush already sent the reply, we're just finalizing here.
        return finish({ ok: true, reply, sessionId: hermesSession, model: "", tools: [] });
      }
      finish({ ok: false, error: err.trim() || `Hermes exited with code ${code}.` });
    });
  });
}

// List Hermes' CLI toolsets with their enabled/disabled state, by parsing
// `hermes tools list --platform cli`. Output lines look like:
//   "  ✓ enabled  web  🔍 Web Search & Scraping"
//   "  ✗ disabled  browser  🌐 Browser Automation"
// We pull out the enabled flag, the toolset NAME (machine id) and a human label.
// Cached CSV of currently-enabled toolset names, fed to `hermes -z -t <csv>` so
// each turn's prompt carries ONLY the checked toolsets. Refreshed whenever we
// list or toggle toolsets; computed lazily on first use. `null` = unknown (then
// we omit -t and let Hermes' config decide, never accidentally disabling all).
let enabledToolsetsCsv = null;
function setEnabledToolsetsFrom(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return;
  enabledToolsetsCsv = tools.filter((t) => t.enabled).map((t) => t.name).join(",");
}
function getEnabledToolsetsCsv() {
  if (enabledToolsetsCsv !== null) return enabledToolsetsCsv;
  // Lazy first-time compute (one extra spawn, then cached for the session).
  const r = hermesToolsList();
  return r.ok ? enabledToolsetsCsv : "";
}

function hermesToolsList() {
  const bin = resolveHermesBin();
  const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const file = useCmd ? "cmd" : bin;
  const args = useCmd
    ? ["/c", bin, "tools", "list", "--platform", "cli"]
    : ["tools", "list", "--platform", "cli"];
  const r = spawnSync(file, args, { timeout: 60_000, encoding: "utf8", windowsHide: true });
  if (r.error) return { ok: false, error: `couldn't run hermes: ${r.error.message}` };
  const text = `${r.stdout || ""}`;
  const tools = [];
  for (const line of text.split(/\r?\n/)) {
    // Match: optional spaces, ✓/✗, "enabled"/"disabled", name, then label.
    const m = line.match(/^\s*[✓✗]\s+(enabled|disabled)\s+(\S+)\s+(.*)$/u);
    if (!m) continue;
    tools.push({ name: m[2], enabled: m[1] === "enabled", label: m[3].trim() });
  }
  if (tools.length === 0)
    return { ok: false, error: r.stderr?.trim() || "no toolsets parsed from hermes output" };
  setEnabledToolsetsFrom(tools); // keep the -t cache in sync
  writeHermesToolsMd(tools); // mirror the ✓/✗ state into the Obsidian vault
  syncToolSchemasDump(enabledToolsetsCsv); // refresh Tool Schemas.md to match -t
  return { ok: true, tools };
}

// Enable or disable ONE Hermes CLI toolset (persists to Hermes' config.yaml),
// then return the refreshed list so the UI reflects the new state.
function hermesToolsSet(name, enabled) {
  if (!/^[a-z0-9_]+$/i.test(String(name)))
    return { ok: false, error: "invalid toolset name" };
  const bin = resolveHermesBin();
  const useCmd = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const file = useCmd ? "cmd" : bin;
  const verb = enabled ? "enable" : "disable";
  const sub = ["tools", verb, name, "--platform", "cli"];
  const args = useCmd ? ["/c", bin, ...sub] : sub;
  const r = spawnSync(file, args, { timeout: 60_000, encoding: "utf8", windowsHide: true });
  if (r.error) return { ok: false, error: `couldn't run hermes: ${r.error.message}` };
  if (r.status !== 0)
    return { ok: false, error: r.stderr?.trim() || r.stdout?.trim() || `hermes tools ${verb} failed` };
  console.log(`[bridge] hermes tools ${verb} ${name} (cli)`);
  return hermesToolsList();
}

// Proxy a chat completion to freellmapi's OpenAI-compatible endpoint. The cloud
// agent loop hands us the same {model, messages, tools?} payload it would send
// to Groq/Gemini, so the local backend slots into the existing tool-calling
// loop. We add the freellmapi bearer here so the token stays bridge-side; the
// `model` field is honored as-is, so JARVIS keeps control of which model runs
// (freellmapi only rotates the keys behind that pinned model).
async function fllmChat(body) {
  try {
    // Sticky-session affinity: the caller may pass `sessionId` (e.g. a coding
    // project id) so freellmapi's `auto` keeps the same model for that session
    // and only rotates on failure. freellmapi reads it from the x-session-id
    // HEADER, so lift it out of the body (and don't forward our own field).
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId) delete body.sessionId;
    const res = await fetchWithTimeout(
      `${resolveFllm().url}/v1/chat/completions`,
      {
        method: "POST",
        headers: fllmHeaders({
          "Content-Type": "application/json",
          ...(sessionId ? { "x-session-id": sessionId } : {}),
        }),
        body: JSON.stringify(body),
      },
      FLLM_TIMEOUT_MS
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error?.message || `freellmapi ${res.status}` };
    return { ok: true, completion: data };
  } catch (e) {
    return { ok: false, error: `freellmapi unreachable: ${e.message}` };
  }
}

// --- HTTP -----------------------------------------------------------------
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function authed(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return token && token === TOKEN;
}

const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    const verbs = ["open", "open_app", "whatsapp_send", "page_snapshot", "page_text", "page_act", "local_status", "local_chat", "hermes_run", ...(shellEnabled ? ["run_shell"] : [])];
    const home =
      process.env.USERPROFILE || process.env.HOME || ""; // the real home dir
    return send(res, 200, { ok: true, verbs, shellEnabled, home });
  }

  // Toggle developer mode at runtime (the bearer token is the gate). Lets the
  // web app's button flip arbitrary-shell on/off without restarting the bridge.
  if (url.pathname === "/dev-mode" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1024) req.destroy();
    });
    req.on("end", () => {
      let enabled = !shellEnabled;
      try {
        const body = JSON.parse(raw || "{}");
        if (typeof body.enabled === "boolean") enabled = body.enabled;
      } catch {
        /* no body => just toggle */
      }
      shellEnabled = enabled;
      console.log(`[bridge] developer mode ${shellEnabled ? "ENABLED" : "disabled"} via web app`);
      return send(res, 200, { ok: true, shellEnabled });
    });
    return;
  }

  if (url.pathname === "/run" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8192) req.destroy();
    });
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      let result;
      try {
      if (body.action === "open") result = openTarget(String(body.target || ""));
      else if (body.action === "whatsapp_send")
        result = whatsAppSend(String(body.target || ""), !!body.autoSend);
      else if (body.action === "open_app")
        result = openApp(
          String(body.target || ""),
          body.fallback ? String(body.fallback) : null,
          body.searchFolder ? String(body.searchFolder) : null,
          body.only === "app" || body.only === "folder" ? body.only : undefined
        );
      else if (body.action === "run_shell") {
        if (!shellEnabled)
          result = { ok: false, error: "developer mode is off (start the bridge with BRIDGE_ALLOW_SHELL=1)" };
        else result = await runShell(String(body.command || ""), body.cwd ? String(body.cwd) : undefined);
      }
      // Browser automation (Phase 2): drive a real, logged-in browser on this
      // machine. Snapshot/text are reads; page_act performs a click/type that the
      // web app has already confirmed with the user. Errors (incl. "Playwright not
      // installed") come back as { ok:false, error } for the UI to read out.
      else if (body.action === "page_open") {
        result = await pageOpen(String(body.target || ""));
      } else if (body.action === "page_snapshot") {
        result = await pageSnapshot(body.target ? String(body.target) : undefined);
      } else if (body.action === "page_text") {
        result = await pageText(body.target ? String(body.target) : undefined);
      } else if (body.action === "page_scroll") {
        result = await pageScroll(
          String(body.direction || "down"),
          body.amount != null ? Number(body.amount) : undefined
        );
      } else if (body.action === "page_act") {
        result = await pageAct(
          String(body.act || ""),
          body.ref != null ? String(body.ref) : undefined,
          body.text != null ? String(body.text) : undefined
        );
      } else result = { ok: false, error: `unsupported action "${body.action}"` };
      } catch (e) {
        // Never let a handler error become an unhandled rejection that crashes
        // the bridge — report it back to the web app as a normal failure.
        const msg = String(e?.message || e);
        console.error(`[bridge] action "${body.action}" failed:`, msg);
        result = { ok: false, error: msg };
      }
      return send(res, result.ok ? 200 : 400, result);
    });
    return;
  }

  // Local-AI presence probe. Jarvis polls this to decide whether to show the
  // "Local" tab and which model modes (local / hybrid) to offer.
  if (url.pathname === "/local/status" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    lastTabPing = Date.now(); // a tab is alive and polling us
    probeLocal().then((p) =>
      send(res, 200, { ok: true, bridge: true, shellEnabled, ...p })
    );
    return;
  }

  // OpenRouter / provider status board. Proxies freellmapi's own admin APIs
  // (/api/keys + /api/models) using the freellmapi bearer the bridge already holds,
  // so the web app can show every provider key (one per Google/OpenRouter account)
  // and each model's availability across ALL keys — no key decryption here.
  if (url.pathname === "/openrouter/status" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    (async () => {
      const { url: base } = resolveFllm();
      try {
        // Preferred: read freellmapi's local DB directly — full keys + models, no auth.
        const fromDb = await readFllmDb();
        if (fromDb && (fromDb.models.length || fromDb.keys.length)) {
          return send(res, 200, { ok: true, keys: fromDb.keys, models: fromDb.models });
        }

        // Next: dashboard session → rich keys + models (per-account status).
        let token = await fllmDashToken(base);
        if (token) {
          const auth = { Authorization: `Bearer ${token}` };
          let keysRes = await fetch(`${base}/api/keys`, { headers: auth });
          // Session may have expired — re-login once.
          if (keysRes.status === 401) {
            token = await fllmDashToken(base, { force: true });
            if (token) keysRes = await fetch(`${base}/api/keys`, { headers: { Authorization: `Bearer ${token}` } });
          }
          if (token && keysRes.ok) {
            const modelsRes = await fetch(`${base}/api/models`, { headers: { Authorization: `Bearer ${token}` } });
            const keys = await keysRes.json().catch(() => []);
            const models = modelsRes.ok ? await modelsRes.json().catch(() => []) : [];
            return send(res, 200, { ok: true, keys, models });
          }
        }
        // Fallback: unified-key /v1/models — available models only, no per-key status.
        const mRes = await fetch(`${base}/v1/models`, { headers: fllmHeaders() });
        if (!mRes.ok) {
          return send(res, 502, { ok: false, error: `freellmapi returned ${mRes.status} — set FREELLMAPI_DASH_EMAIL/PASSWORD in the bridge env for full status, and check the freellmapi key.` });
        }
        const body = await mRes.json().catch(() => ({}));
        const models = (Array.isArray(body.data) ? body.data : [])
          .filter((m) => m && m.id && m.owned_by !== "freellmapi")
          .map((m) => ({ id: m.id, platform: m.owned_by || "openrouter", modelId: m.id, displayName: m.name || m.id, enabled: true, contextWindow: m.context_window ?? null }));
        return send(res, 200, { ok: true, keys: [], models, note: "Set FREELLMAPI_DASH_EMAIL + FREELLMAPI_DASH_PASSWORD in the bridge env to see per-account key status." });
      } catch (e) {
        return send(res, 502, { ok: false, error: String((e && e.message) || e) });
      }
    })();
    return;
  }

  // Local model inference (freellmapi). The cloud agent loop posts an OpenAI-
  // shaped {model, messages, tools?} payload; we relay it to freellmapi and
  // return the completion verbatim so the existing tool-calling loop is unchanged.
  if (url.pathname === "/local/chat" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
      if (!body.model || !Array.isArray(body.messages))
        return send(res, 400, { error: "model and messages[] required" });
      const result = await fllmChat(body);
      return send(res, result.ok ? 200 : 502, result);
    });
    return;
  }

  // NOTE: Hermes Agent has been removed. Local voice turns now run on JARVIS's
  // OWN native tool loop (browser-driven; inference via the app's /api/v1 router),
  // so the bridge no longer exposes any /hermes/* endpoints. It only provides the
  // local TOOLS (open_app / run_shell / browser automation), presence and the
  // Coding-mode /local/chat relay.

  send(res, 404, { error: "not found" });
});

// Poll for "tab closed" so the visible Hermes browser shuts when you leave.
const tabWatch = setInterval(closeDebugChromeIfTabGone, 10_000);
if (typeof tabWatch.unref === "function") tabWatch.unref();

if (MODEL_SYNC) {
  // Two-way mirror of the per-model caps (tpd/rpd/rpm) ⇄ freellmapi's DB.
  syncModelCaps();
  const capsWatch = setInterval(syncModelCaps, MODEL_SYNC_MS);
  if (typeof capsWatch.unref === "function") capsWatch.unref();
  // Two-way mirror of the router's failure cooldowns (rate-limit / client-error).
  syncRouterCooldowns();
  const cooldownWatch = setInterval(syncRouterCooldowns, MODEL_SYNC_MS);
  if (typeof cooldownWatch.unref === "function") cooldownWatch.unref();
}

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  PersonalAI local bridge running");
  console.log(`  → http://${HOST}:${PORT}`);
  console.log("  → verbs: open (urls/uris), open_app (apps)");
  if (shellEnabled) {
    console.log("  → run_shell: DEVELOPER MODE ON — arbitrary PowerShell is");
    console.log("    enabled. Commands are gated + you confirm each one in the");
    console.log("    browser, but only run this on a machine you trust.");
  } else {
    console.log("  → run_shell: developer mode OFF (toggle it from the web app's");
    console.log("    bridge settings, or start with BRIDGE_ALLOW_SHELL=1).");
  }
  console.log("");
  console.log("  Paste this token into the web app's Bridge settings:");
  console.log("");
  console.log(`      ${TOKEN}`);
  console.log("");
  console.log("  (also saved to scripts/bridge/.bridge-token)");
  console.log("  Press Ctrl+C to stop. Nothing opens without your confirmation.");
  console.log("");
});

// If the port's already taken, a bridge is most likely already running — say so
// and exit cleanly (code 0) instead of crashing with a stack trace. The dev
// launcher treats a clean bridge exit as "fine, carry on".
// Close the automation browser when the bridge stops, so we don't leave an
// orphan Chromium running.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`  PersonalAI bridge: port ${PORT} already in use — assuming a`);
    console.log("  bridge is already running. Nothing to do.");
    process.exit(0);
  }
  console.error("[bridge] server error:", err.message);
  process.exit(1);
});
