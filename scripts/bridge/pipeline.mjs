// Self-contained pipeline-phase runner for the laptop bridge.
//
// When the phone starts a pipeline phase, the cloud relays a `pipeline_phase`
// command here. The bridge owns the filesystem + shell, so it runs the WHOLE
// phase loop locally and streams progress to the cloud event channel
// (/api/pipeline/events) for the phone to watch. This is a faithful port of the
// browser loop in lib/pipeline-agent.ts (runPhase), with the IO bound to native
// node instead of the app's HTTP endpoints:
//   • prompts/tools  → fetched from the cloud /api/pipeline/prep (single source)
//   • file tools     → native node:fs, scoped to the project workdir (ported from
//                      lib/coding.ts runCodingFileTool — the path scoping is the
//                      safety boundary)
//   • run_shell      → the bridge's own runShell (same safety gates as /run)
//   • browser tools  → the bridge's page* handlers
//   • inference      → the app's rotating router at /api/v1/chat/completions
//   • store/memory   → cloud DB via /api/pipeline/* (so the phone sees state)
//
// The run is fire-and-forget: dispatchAction acks the relay command immediately
// (a phase takes minutes, far past the relay's 90s stale window), and real
// progress flows through the event stream.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { homedir } from "node:os";

// Where pipeline run logs are written on the laptop — one markdown file per
// project. Defaults to the Obsidian project-memory vault's `pipeline` folder so
// the user can read every run in Obsidian; override with PIPELINE_LOG_DIR.
const LOG_DIR =
  process.env.PIPELINE_LOG_DIR ||
  join(homedir(), "Downloads", "Projects", "Jarvis Personal AI", "pipeline");

function appendPipelineLog(projectId, line) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${projectId}.md`), line.endsWith("\n") ? line : line + "\n");
  } catch {
    /* best-effort — never let logging break a run */
  }
}

const MAX_FILE_BYTES = 200_000;
const MAX_LIST = 400;
const VERIFY_RE =
  /\b(tsc|build|test|lint|check|compile|pytest|jest|vitest|cargo|go\s+build|node\s+--check|mvn|gradle|make)\b/i;

const TEAM_LABEL = { planning: "Planning", executing: "Execution", reviewing: "Review & Test" };

// Defaults mirror lib/pipeline-config.ts PIPELINE_DEFAULTS; the phone overrides
// via the command's `cfg`, but a missing field must never wedge the loop.
const CFG_DEFAULTS = {
  maxRoundsPerPhase: 30,
  modelRetries: 2,
  repeatNudgeAt: 2,
  repeatAbortAt: 5,
  toolResultCap: 2000,
  keepFullRounds: 2,
  temperature: 0.2,
};

// ── ported scoped file tools (lib/coding.ts) ─────────────────────────────────
function safeResolve(workdir, rel) {
  if (!workdir) return null;
  const root = resolve(workdir);
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const r = relative(root, target);
  if (r === "") return target;
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return target;
}

function runFileTool(workdir, name, args) {
  const rel = String(args?.path ?? args?.file ?? "");
  switch (name) {
    case "list_dir": {
      const dir = safeResolve(workdir, rel || ".");
      if (!dir) return { ok: false, error: "path is outside the project folder" };
      try {
        if (!existsSync(dir)) return { ok: false, error: "no such folder" };
        const entries = readdirSync(dir, { withFileTypes: true })
          .slice(0, MAX_LIST)
          .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        return { ok: true, path: rel || ".", entries };
      } catch (e) {
        return { ok: false, error: e?.message || "couldn't list folder" };
      }
    }
    case "read_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      try {
        if (!existsSync(f) || !statSync(f).isFile()) return { ok: false, error: "no such file" };
        let content = readFileSync(f, "utf8");
        const truncated = content.length > MAX_FILE_BYTES;
        if (truncated) content = content.slice(0, MAX_FILE_BYTES);
        return { ok: true, path: rel, content, truncated };
      } catch (e) {
        return { ok: false, error: e?.message || "couldn't read file" };
      }
    }
    case "write_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      try {
        const d = dirname(f);
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
        writeFileSync(f, String(args?.content ?? ""));
        return { ok: true, path: rel, message: `Wrote ${rel}` };
      } catch (e) {
        return { ok: false, error: e?.message || "couldn't write file" };
      }
    }
    case "edit_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      const oldStr = String(args?.old ?? args?.old_string ?? "");
      const newStr = String(args?.new ?? args?.new_string ?? "");
      if (!oldStr) return { ok: false, error: "edit_file needs the exact old text to replace" };
      try {
        if (!existsSync(f)) return { ok: false, error: "no such file" };
        const content = readFileSync(f, "utf8");
        const count = content.split(oldStr).length - 1;
        if (count === 0) return { ok: false, error: "old text not found in the file" };
        if (count > 1) return { ok: false, error: `old text appears ${count} times — make it unique` };
        writeFileSync(f, content.replace(oldStr, newStr));
        return { ok: true, path: rel, message: `Edited ${rel}` };
      } catch (e) {
        return { ok: false, error: e?.message || "couldn't edit file" };
      }
    }
    default:
      return { ok: false, error: `unknown file tool ${name}` };
  }
}

const FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file", "list_dir"]);
const BROWSER_TOOL_NAMES = new Set([
  "browser_open",
  "browser_snapshot",
  "browser_scroll",
  "browser_act",
  "browser_read",
]);

// ── helpers ───────────────────────────────────────────────────────────────────
const extractThink = (s) => ((s || "").match(/<think>([\s\S]*?)<\/think>/i)?.[1] || "").trim();
const clean = (s) =>
  (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
const ok = (r) => !(r && (r.ok === false || r.error));
function shortResult(r) {
  if (r == null) return "";
  if (r.error) return String(r.error);
  if (r.message) return String(r.message);
  if (typeof r === "object") return JSON.stringify(r).slice(0, 200);
  return String(r).slice(0, 200);
}
function describeCall(name, args) {
  const a = args || {};
  switch (name) {
    case "list_dir": return { summary: `Listing ${a.path || "the working folder"}` };
    case "read_file": return { summary: `Reading ${a.path}` };
    case "write_file": return { summary: `Writing ${a.path}`, detail: typeof a.content === "string" ? `${a.content.length} chars` : undefined };
    case "edit_file": return { summary: `Editing ${a.path}` };
    case "run_shell": return { summary: `Running a command`, detail: String(a.command || "") };
    case "browser_open": return { summary: `Opening ${a.url} in the browser` };
    case "browser_snapshot": return { summary: `Looking at the page` };
    case "browser_scroll": return { summary: `Scrolling the page` };
    case "browser_act": return { summary: `Acting on the page (${a.action || "action"})` };
    case "browser_read": return { summary: `Reading the page` };
    default: return { summary: `Using ${name}` };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track in-flight runs so a duplicate start command is ignored and a stop
// command can abort. Keyed by projectId.
const RUNNING = new Map(); // projectId -> { stop: boolean }

export function isPipelineRunning(projectId) {
  return RUNNING.has(projectId);
}
export function stopPipeline(projectId) {
  const h = RUNNING.get(projectId);
  if (h) h.stop = true;
  return !!h;
}

// Fire-and-forget entry point called from dispatchAction. `deps` carries the
// bridge primitives + endpoints so this module stays decoupled from server.mjs.
export function startPipelinePhase(body, deps) {
  const projectId = String(body.projectId || body.id || "");
  const phase = String(body.phase || "");
  if (!projectId || !TEAM_LABEL[phase]) {
    return { ok: false, error: "pipeline_phase needs projectId + a valid phase" };
  }
  if (RUNNING.has(projectId)) {
    return { ok: false, error: "a phase is already running for this project" };
  }
  const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : [];
  const cfg = { ...CFG_DEFAULTS, ...(body.cfg && typeof body.cfg === "object" ? body.cfg : {}) };
  const handle = { stop: false };
  RUNNING.set(projectId, handle);
  // Run detached; never let a throw escape into the relay poll loop.
  runPhase({ projectId, phase, models, cfg, handle }, deps)
    .catch((e) => deps.log?.(`[pipeline] phase crashed: ${e?.message || e}`))
    .finally(() => RUNNING.delete(projectId));
  return { ok: true, started: true, projectId, phase };
}

// ── the loop (port of lib/pipeline-agent.ts runPhase) ─────────────────────────
async function runPhase({ projectId, phase, models, cfg, handle }, deps) {
  const team = TEAM_LABEL[phase];
  const { jarvisUrl, relayUrl, relaySecret, proxyKey } = deps;

  // Buffered event stream → cloud. Flushes on a timer and on terminal events so
  // the phone sees steady progress without a request per line.
  const pending = [];
  let firstFlush = true;
  let flushing = false;
  async function flush(force = false) {
    if (flushing || (pending.length === 0 && !force)) return;
    flushing = true;
    const batch = pending.splice(0, pending.length);
    try {
      await fetchJson(`${relayUrl}/api/pipeline/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${relaySecret}` },
        body: JSON.stringify({ id: projectId, started: firstFlush, events: batch }),
      });
      firstFlush = false;
    } catch {
      // Put them back so the next flush retries (bounded by the loop ending).
      pending.unshift(...batch);
    } finally {
      flushing = false;
    }
  }
  function emit(e) {
    pending.push(e);
    deps.log?.(`[pipeline ${projectId.slice(0, 6)}/${phase}] ${e.phase}: ${e.summary || ""}`.slice(0, 200));
    // Durable per-project run log in the Obsidian vault (one line per event).
    const ts = new Date().toISOString();
    const tool = e.tool ? ` ${e.tool}` : "";
    const status = e.status ? ` (${e.status})` : "";
    const detail = e.detail ? ` — ${String(e.detail).slice(0, 300)}` : "";
    appendPipelineLog(projectId, `- ${ts} [${e.phase}${tool}]${status} ${e.summary || ""}${detail}`);
  }
  appendPipelineLog(
    projectId,
    `\n## ${new Date().toISOString()} — ${team} phase started${models.length ? ` · models: ${models.join(", ")}` : ""}\n`
  );
  const flusher = setInterval(() => void flush(), 1000);

  // Best-effort cloud store updates (phase pointer, memory, phase report).
  const setPhase = (ph) => patchProject(jarvisUrl, projectId, { phase: ph }).catch(() => {});
  const appendMemory = (entry) =>
    fetchJson(`${jarvisUrl}/api/pipeline/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, entry }),
    }).catch(() => {});
  const syncPhaseDoc = (summary) =>
    fetchJson(`${jarvisUrl}/api/pipeline/phase-doc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, phase, summary }),
    }).catch(() => {});
  const logError = async (line) => {
    // Append to error.md in the workdir (durable, read by the next run).
    try {
      const prev = runFileTool(workdir, "read_file", { path: "error.md" });
      const base =
        prev.ok && typeof prev.content === "string" && prev.content.trim()
          ? prev.content
          : "# error.md — unresolved problems for the next run to fix\n";
      runFileTool(workdir, "write_file", {
        path: "error.md",
        content: `${base}\n- [${new Date().toISOString()}] ${line}`,
      });
    } catch { /* best-effort */ }
  };

  const finish = async (status, summary) => {
    // Emit ONE terminal event (phase ∈ done|stopped|capped|error) — the event
    // store flips `running` false on any of these, so the phone stops polling.
    emit({ phase: status, team, summary, status: status === "done" ? "ok" : "failed" });
    await flush(true);
    clearInterval(flusher);
    return { status, summary };
  };

  // 1) prep — single source of truth for the phase prompt + tools.
  let prep;
  try {
    prep = await fetchJson(`${jarvisUrl}/api/pipeline/prep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, phase }),
    });
    if (!prep?.system) return finish("error", "Couldn't prepare the phase (no prompt).");
  } catch (e) {
    return finish("error", `Couldn't reach the server to prepare the phase (${e?.message || e}).`);
  }

  // Resolve the working folder. Empty → a stable default under the user's home so
  // a project created on the phone (no path picker) still has somewhere to build.
  // Strip surrounding quotes: the path picker can store the folder wrapped in
  // literal double/single quotes (e.g. `"C:\…\Pipeline Projects"`), which is an
  // invalid Windows path and breaks mkdir + every run_shell cwd. Unwrap them.
  let workdir = String(prep.workdir || "").trim().replace(/^['"]+|['"]+$/g, "").trim();
  if (!workdir) workdir = join(homedir(), "JarvisPipelines", projectId);
  try { mkdirSync(workdir, { recursive: true }); } catch { /* best-effort */ }

  const chain = models.filter(Boolean);
  if (!chain.length) return finish("error", `No models assigned to the ${team} team.`);
  let chainIdx = 0;
  let currentModel = chain[chainIdx];
  let lastModel = "";
  emit({
    phase: "info",
    team,
    model: currentModel,
    summary: `${team} team starting — ${currentModel}${chain.length > 1 ? ` (+${chain.length - 1} fallback${chain.length > 2 ? "s" : ""})` : ""}…`,
  });
  // Point the store at the phase now running (store enum uses these names too).
  await setPhase(phase);

  const doneMarker = prep.doneMarker;
  const messages = [
    { role: "system", content: prep.system },
    { role: "user", content: `Begin the ${team} work. Work autonomously and narrate what you're doing.` },
  ];

  // Tool-result compaction (stable indexes; stub aged results).
  const toolMeta = [];
  function compactHistory(currentRound) {
    for (const m of toolMeta) {
      if (m.stubbed || m.round > currentRound - cfg.keepFullRounds) continue;
      const msg = messages[m.idx];
      if (!msg || typeof msg.content !== "string") continue;
      const stub = `[earlier result elided to save context] ${m.brief}`;
      if (msg.content.length > stub.length) { msg.content = stub; m.stubbed = true; }
    }
  }

  let verifiedOnce = false;
  let verifyNudged = false;
  const sigCounts = new Map();

  function escalate(reason) {
    if (chainIdx >= chain.length - 1) return false;
    chainIdx++;
    currentModel = chain[chainIdx];
    lastModel = currentModel;
    sigCounts.clear();
    emit({ phase: "review", team, model: currentModel, summary: `↻ ${reason} — handing off to ${currentModel}` });
    appendMemory(`[${team}] ↻ Switched to ${currentModel} (${reason}); context carried over.`);
    messages.push({
      role: "user",
      content:
        "A different model is now taking over. Read the work so far, then take the next concrete step. " +
        `When the ${team} work is genuinely done, end with ${doneMarker}.`,
    });
    return true;
  }

  for (let round = 1; round <= cfg.maxRoundsPerPhase; round++) {
    if (handle.stop) return finish("stopped", "Stopped.");
    compactHistory(round);
    emit({ phase: "info", team, summary: "Thinking…", round });

    const chatBody = {
      model: currentModel,
      messages,
      tools: prep.tools,
      tool_choice: "auto",
      temperature: cfg.temperature,
    };
    let r = await routerChat(jarvisUrl, proxyKey, chatBody);
    for (let attempt = 1; attempt <= cfg.modelRetries && (!r.ok || !r.completion) && !handle.stop; attempt++) {
      emit({ phase: "info", team, summary: `Model call failed (${r.error || "no response"}) — retrying ${attempt}/${cfg.modelRetries}…`, round });
      await sleep(800 * attempt);
      r = await routerChat(jarvisUrl, proxyKey, chatBody);
    }
    if (handle.stop) return finish("stopped", "Stopped.");
    if (!r.ok || !r.completion) {
      if (escalate(r.error || "model error")) continue;
      return finish("error", r.error || "The model didn't respond.");
    }

    const usedModel = r.completion.model || currentModel;
    if (usedModel && usedModel !== lastModel) {
      emit({ phase: "info", team, model: usedModel, summary: `Model: ${usedModel}`, round });
      lastModel = usedModel;
    }

    const msg = r.completion.choices?.[0]?.message;
    if (!msg) return finish("error", "The model returned nothing.");

    const think = extractThink(msg.content);
    if (think) emit({ phase: "thinking", team, summary: think.slice(0, 240), round });

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = clean(msg.content);
      if (text) emit({ phase: "info", team, summary: text.slice(0, 400), round });
      if (text && text.includes(doneMarker)) {
        if (phase === "executing" && !verifiedOnce && !verifyNudged) {
          verifyNudged = true;
          emit({ phase: "info", team, summary: "Not done yet — must verify with a build/test first.", round });
          messages.push(msg);
          messages.push({
            role: "user",
            content:
              "You ended without ever running a build or test that PASSED. Before finishing, run the project's own " +
              "verification command with run_shell (e.g. `npm run build`, `tsc --noEmit`, `npm test`, `pytest`, `cargo build`, " +
              "`go build ./...`, or `node --check <file>`) and confirm it exits cleanly. If it fails, fix the root cause and " +
              `re-run. Only emit ${doneMarker} after a verification command has succeeded.`,
          });
          continue;
        }
        const summary = text.replace(doneMarker, "").trim() || `${team} complete.`;
        await appendMemory(`**[${team}] Done.** ${summary}`);
        await syncPhaseDoc(summary);
        return finish("done", summary);
      }
      messages.push(msg);
      messages.push({
        role: "user",
        content: `Continue. If the ${team} work is fully done, end with ${doneMarker}; otherwise take the next concrete step with a tool.`,
      });
      continue;
    }

    messages.push(msg);
    const memoryNotes = [];
    let repeatedCall = false;
    let stuck = false;
    for (const call of calls) {
      if (handle.stop) return finish("stopped", "Stopped.");
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* empty */ }
      if (args === null || typeof args !== "object") args = {};
      const name = call.function?.name || "";
      const d = describeCall(name, args);
      emit({ phase: "tool", team, tool: name, summary: d.summary, detail: d.detail, status: "running", round });

      const result = await execTool(name, args, workdir, deps);
      const good = ok(result);
      emit({ phase: "result", team, tool: name, summary: d.summary, detail: shortResult(result), status: good ? "ok" : "failed", round });
      memoryNotes.push(`${good ? "✓" : "✗"} ${d.summary}${d.detail ? ` — ${d.detail}` : ""}${good ? "" : ` (${shortResult(result)})`}`);
      if (good && name === "run_shell" && VERIFY_RE.test(String(args?.command ?? ""))) verifiedOnce = true;
      if (!good && (name === "run_shell" || name === "write_file" || name === "edit_file")) {
        await logError(`[${team}] ${d.summary}${d.detail ? ` (${d.detail})` : ""}: ${shortResult(result)}`);
      }

      const sig = `${name}|${JSON.stringify(args)}`;
      const count = (sigCounts.get(sig) || 0) + 1;
      sigCounts.set(sig, count);
      if (count >= cfg.repeatNudgeAt) repeatedCall = true;
      if (count >= cfg.repeatAbortAt) stuck = true;

      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, cfg.toolResultCap) });
      toolMeta.push({ idx: messages.length - 1, round, brief: `${good ? "✓" : "✗"} ${d.summary}${d.detail ? ` (${d.detail})` : ""}` });
    }
    if (memoryNotes.length) await appendMemory(`[${team}] Step ${round}:\n${memoryNotes.join("\n")}`);

    if (stuck) {
      await appendMemory(`**[${team}] Stuck.** Repeated a call ${cfg.repeatAbortAt}× on ${currentModel}.`);
      if (escalate("stuck repeating a call")) continue;
      return finish("error", "Stuck repeating a call and no other model is available — stopped.");
    }
    if (repeatedCall) {
      messages.push({
        role: "user",
        content:
          "You are repeating tool calls you have already run. STOP re-exploring and take a new concrete step now. " +
          `If you are blocked, say exactly what's blocking you. When the ${team} work is genuinely done, end with ${doneMarker}.`,
      });
    }
  }

  await appendMemory(`**[${team}] Paused** after ${cfg.maxRoundsPerPhase} steps (cap reached).`);
  return finish("capped", `Reached the ${cfg.maxRoundsPerPhase}-step limit.`);
}

// ── one tool call → native execution ──────────────────────────────────────────
async function execTool(name, args, workdir, deps) {
  try {
    if (FILE_TOOL_NAMES.has(name)) return runFileTool(workdir, name, args);
    if (name === "run_shell") {
      const r = await deps.runShell(String(args?.command ?? ""), workdir);
      return r.ok
        ? { ok: true, message: r.message, output: r.output ?? "" }
        : { ok: false, error: r.message || r.error || "command failed" };
    }
    if (BROWSER_TOOL_NAMES.has(name)) return await execBrowser(name, args, deps);
    return { ok: false, error: `tool ${name} not available in this phase` };
  } catch (e) {
    return { ok: false, error: e?.message || "tool execution failed" };
  }
}

async function execBrowser(name, args, deps) {
  const a = args || {};
  switch (name) {
    case "browser_open": return await deps.pageOpen(String(a.url || a.target || ""));
    case "browser_snapshot": return await deps.pageSnapshot(a.target ? String(a.target) : undefined);
    case "browser_read": return await deps.pageText(a.target ? String(a.target) : undefined);
    case "browser_scroll": return await deps.pageScroll(String(a.direction || "down"), a.amount != null ? Number(a.amount) : undefined);
    case "browser_act": return await deps.pageAct(String(a.act || a.action || ""), a.ref != null ? String(a.ref) : undefined, a.text != null ? String(a.text) : undefined);
    default: return { ok: false, error: `unknown browser tool ${name}` };
  }
}

// ── cloud calls ───────────────────────────────────────────────────────────────
async function routerChat(jarvisUrl, proxyKey, body) {
  try {
    const res = await fetch(`${jarvisUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(proxyKey ? { Authorization: `Bearer ${proxyKey}` } : {}) },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error?.message || data?.error || `router error (${res.status})`;
      return { ok: false, error: typeof err === "string" ? err : `router error (${res.status})` };
    }
    return { ok: true, completion: data };
  } catch {
    return { ok: false, error: "Couldn't reach the LLM router (/api/v1)." };
  }
}

async function patchProject(jarvisUrl, id, patch) {
  return fetchJson(`${jarvisUrl}/api/pipeline/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json().catch(() => ({}));
}
