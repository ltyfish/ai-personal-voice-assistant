"use client";

// The 3-team coding PIPELINE loop (client-driven, like lib/coding-agent.ts).
//
// One pipeline run is three phases in order:
//   planning  → studies the codebase, writes the plan file (no app code changes)
//   executing → reads ONLY that plan + the prompt and implements it
//   reviewing → (optional) reads prompt + plan + changed code, tests/reviews
//
// Each phase is its OWN model chain: the user assigns + orders models per team card,
// and the phase tries them in that order, escalating to the next only on failure or
// when a model gets stuck. The browser drives the loop because only it can reach the
// localhost bridge (run_shell + the controlled browser). Inference now goes through
// JARVIS's own rotating router (/api/v1, lib/llm-router.ts), NOT freellmapi.

import { routerChat, execBrowserTool, BROWSER_TOOLS } from "./local-agent";
import { runShell } from "./bridge";
import { PIPELINE_DEFAULTS, type PipelineConfig } from "./pipeline-config";

const CODING_FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file", "list_dir"]);

// Token control: tool results are the bulk of a phase's growing context (a single
// read_file can be thousands of chars, re-sent every round). We cap each result
// and, once it's a couple of rounds old, collapse it to a one-line stub — the
// model has already acted on it, so the full text no longer needs to be re-sent.
// The caps + step budget + retry/stuck thresholds are all user-tunable via
// PipelineConfig (lib/pipeline-config.ts); a run with no cfg uses the defaults.

// A successful command matching this is treated as a real verification (build /
// typecheck / test / lint), kept language-agnostic so it works across stacks.
const VERIFY_RE = /\b(tsc|build|test|lint|check|compile|pytest|jest|vitest|cargo|go\s+build|node\s+--check|mvn|gradle|make)\b/i;

export type Phase = "planning" | "executing" | "reviewing";

export type PipelineEvent = {
  phase: "thinking" | "tool" | "result" | "review" | "done" | "error" | "info";
  team?: string; // human label of the team that emitted this (e.g. "Execution")
  summary: string;
  detail?: string;
  tool?: string;
  status?: "running" | "ok" | "failed";
  round?: number;
  model?: string; // the model now driving this phase (set on start + every rotation)
};
type Progress = (e: PipelineEvent) => void;

export type PhaseResult = { status: "done" | "stopped" | "error" | "capped"; summary: string };

const TEAM_LABEL: Record<Phase, string> = {
  planning: "Planning",
  executing: "Execution",
  reviewing: "Review & Test",
};

export type Difficulty = "easy" | "medium" | "hard";

// Smart execution routing. The team chain comes in best→worst (sorted by model
// rank). We reorder it so the FIRST model matches the task's difficulty and any
// escalation climbs toward MORE capable models (never down to a weaker one):
//   hard   → unchanged (strongest first; nothing stronger to climb to)
//   medium → start at the middle model, then climb the stronger half, weaker tail last
//   easy   → weakest first, climbing up to the strongest only if the weak ones fail
// Easy tasks therefore spend cheap-model quota and reserve the strong models for
// hard work, while a wrong guess still self-heals by escalating upward.
export function orderChainForDifficulty(chain: string[], difficulty: Difficulty): string[] {
  if (chain.length <= 1 || difficulty === "hard") return [...chain];
  if (difficulty === "easy") return [...chain].reverse();
  const mid = Math.floor(chain.length / 2);
  const fromMidUp = chain.slice(0, mid + 1).reverse(); // middle → strongest
  const weakerTail = chain.slice(mid + 1); // weaker than middle, last resort
  return [...fromMidUp, ...weakerTail];
}

function describeCall(name: string, args: any): { summary: string; detail?: string } {
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

async function execTool(projectId: string, name: string, args: any, workdir?: string): Promise<any> {
  try {
    if (CODING_FILE_TOOL_NAMES.has(name)) {
      const res = await fetch("/api/pipeline/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name, args }),
      });
      const data = await res.json().catch(() => ({}));
      return data.result ?? { ok: false, error: "file tool failed" };
    }
    if (BROWSER_TOOLS.has(name)) return await execBrowserTool(name, args);
    if (name === "run_shell") {
      // Run in the project's working folder so scaffolders/builds/installs land
      // there, not in the bridge's own dir (which would pollute the wrong repo).
      const r = await runShell(String(args?.command ?? ""), workdir);
      return r.ok ? { ok: true, message: r.message, output: r.output ?? "" } : { ok: false, error: r.message };
    }
    return { ok: false, error: `tool ${name} not available in this phase` };
  } catch (e: any) {
    return { ok: false, error: e?.message || "tool execution failed" };
  }
}

const ok = (r: any): boolean => !(r && (r.ok === false || r.error));
function shortResult(r: any): string {
  if (r == null) return "";
  if (r.error) return String(r.error);
  if (r.message) return String(r.message);
  if (typeof r === "object") return JSON.stringify(r).slice(0, 200);
  return String(r).slice(0, 200);
}
const extractThink = (s?: string | null) => ((s || "").match(/<think>([\s\S]*?)<\/think>/i)?.[1] || "").trim();
const clean = (s?: string | null) => (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();

// Append a failure to error.md in the project's WORKING folder (durable across
// restarts, so a phase that gets re-run still sees unresolved problems and the
// prompt tells the model to clear them). Read-modify-write via the scoped file
// tools. Best-effort: a logging failure must never break the loop.
async function logError(projectId: string, line: string) {
  try {
    const read = await fetch("/api/pipeline/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, name: "read_file", args: { path: "error.md" } }),
    });
    const prev = (await read.json().catch(() => ({})))?.result?.content;
    const header = "# error.md — unresolved problems for the next run to fix\n";
    const base = typeof prev === "string" && prev.trim() ? prev : header;
    const stamp = new Date().toISOString();
    await fetch("/api/pipeline/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, name: "write_file", args: { path: "error.md", content: `${base}\n- [${stamp}] ${line}` } }),
    });
  } catch { /* best-effort */ }
}

async function appendMemory(projectId: string, entry: string) {
  try {
    await fetch("/api/pipeline/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, entry }),
    });
  } catch { /* best-effort */ }
}

// Mirror a finished phase's output to its own Markdown file in the project's vault
// folder (planning.md / execution.md / review.md) so it's browsable in Obsidian.
async function syncPhaseDoc(projectId: string, phase: Phase, summary: string) {
  try {
    await fetch("/api/pipeline/phase-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, phase, summary }),
    });
  } catch { /* best-effort */ }
}

async function setPhase(projectId: string, phase: string) {
  try {
    await fetch(`/api/pipeline/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase }),
    });
  } catch { /* best-effort */ }
}

// Run ONE phase of the pipeline with its own ordered model chain.
//   models — the user's ordered list for this team (tried in order, escalate on
//            failure/stuck). Empty → "auto" (let the bridge/freellmapi rotate).
export async function runPhase(
  projectId: string,
  phase: Phase,
  models: string[],
  opts: { onProgress: Progress; signal?: AbortSignal; runningPhase?: string; cfg?: PipelineConfig }
): Promise<PhaseResult> {
  const { onProgress, signal } = opts;
  const cfg = opts.cfg ?? PIPELINE_DEFAULTS;
  const MAX_ROUNDS = cfg.maxRoundsPerPhase;
  const TOOL_RESULT_CAP = cfg.toolResultCap;
  const KEEP_FULL_ROUNDS = cfg.keepFullRounds;
  const stopped = () => signal?.aborted;
  const team = TEAM_LABEL[phase];

  // 1) Prep: phase system prompt + the tools this phase may use.
  let prep: { system: string; tools: any[]; planFile: string; doneMarker: string; workdir?: string };
  try {
    const res = await fetch("/api/pipeline/prep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, phase }),
    });
    prep = await res.json();
    if (!res.ok || !prep?.system) {
      onProgress({ phase: "error", team, summary: `Couldn't prepare the ${team} phase.` });
      return { status: "error", summary: "prep failed" };
    }
  } catch {
    onProgress({ phase: "error", team, summary: "Couldn't reach the server to prepare the phase." });
    return { status: "error", summary: "prep unreachable" };
  }

  if (opts.runningPhase) await setPhase(projectId, opts.runningPhase);

  // The team's ordered model chain — each id is "<platform>/<model>" for the
  // router. The router has no "auto", so an empty chain is a real config error.
  const chain = models.filter(Boolean);
  if (!chain.length) {
    onProgress({ phase: "error", team, summary: `No models assigned to the ${team} team — add at least one on its card.` });
    return { status: "error", summary: "no models assigned" };
  }
  let chainIdx = 0;
  let currentModel = chain[chainIdx];
  onProgress({
    phase: "info",
    team,
    model: currentModel,
    summary: `${team} team starting — ${currentModel}${chain.length > 1 ? ` (+${chain.length - 1} fallback${chain.length > 2 ? "s" : ""})` : ""}…`,
  });
  let lastModel = "";

  const messages: any[] = [
    { role: "system", content: prep.system },
    { role: "user", content: `Begin the ${team} work. Work autonomously and narrate what you're doing.` },
  ];
  const doneMarker = prep.doneMarker;

  // Tool-result history compaction. We never splice `messages` (indexes must stay
  // stable for tool_call_id pairing), so we track each tool message's index +
  // round and overwrite its content with a short stub once it ages out.
  const toolMeta: { idx: number; round: number; brief: string; stubbed?: boolean }[] = [];
  function compactHistory(currentRound: number) {
    for (const m of toolMeta) {
      if (m.stubbed || m.round > currentRound - KEEP_FULL_ROUNDS) continue;
      const msg = messages[m.idx];
      if (!msg || typeof msg.content !== "string") continue;
      const stub = `[earlier result elided to save context] ${m.brief}`;
      // Stub any aged result that's longer than its stub — the model already
      // acted on it, so re-sending the full text every round just burns tokens.
      if (msg.content.length > stub.length) {
        msg.content = stub;
        m.stubbed = true;
      }
    }
  }

  // Verification gate (executing phase): the model may not declare the work done
  // until it has actually run a build/test/typecheck that PASSED. Catches
  // "all the files exist" being mistaken for "the app runs".
  let verifiedOnce = false;
  let verifyNudged = false;

  const sigCounts = new Map<string, number>();
  const REPEAT_NUDGE_AT = cfg.repeatNudgeAt;
  const REPEAT_ABORT_AT = cfg.repeatAbortAt;

  // Transient-failure auto-retry: a model/bridge call can fail for a blip
  // (network, model cold-start, rate limit). Retry the SAME model a few times
  // with a short backoff before giving up on it and escalating down the chain.
  const MODEL_RETRY_MAX = cfg.modelRetries;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  function escalate(reason: string): boolean {
    if (chainIdx >= chain.length - 1) return false;
    chainIdx++;
    currentModel = chain[chainIdx];
    lastModel = currentModel;
    sigCounts.clear();
    onProgress({ phase: "review", team, model: currentModel, summary: `↻ ${reason} — handing off to ${currentModel}` });
    appendMemory(projectId, `[${team}] ↻ Switched to ${currentModel} (${reason}); context carried over.`);
    messages.push({
      role: "user",
      content:
        "A different model is now taking over. Read the work so far, then take the next concrete step. " +
        `When the ${team} work is genuinely done, end with ${doneMarker}.`,
    });
    return true;
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (stopped()) { onProgress({ phase: "info", team, summary: "Stopped." }); return { status: "stopped", summary: "stopped by user" }; }

    compactHistory(round);
    onProgress({ phase: "info", team, summary: "Thinking…", round });
    // Auto-retry the same model on a transient failure before escalating. The
    // router is stateless (full context rides `messages`), so no session id.
    const chatBody = {
      model: currentModel,
      messages,
      tools: prep.tools,
      tool_choice: "auto",
      temperature: cfg.temperature,
    };
    let r = await routerChat(chatBody);
    for (let attempt = 1; attempt <= MODEL_RETRY_MAX && (!r.ok || !r.completion) && !stopped(); attempt++) {
      onProgress({ phase: "info", team, summary: `Model call failed (${r.error || "no response"}) — retrying ${attempt}/${MODEL_RETRY_MAX}…`, round });
      await sleep(800 * attempt);
      r = await routerChat(chatBody);
    }
    if (stopped()) return { status: "stopped", summary: "stopped by user" };
    if (!r.ok || !r.completion) {
      if (escalate(r.error || "model error")) continue;
      onProgress({ phase: "error", team, summary: r.error || "The model didn't respond." });
      return { status: "error", summary: r.error || "model error" };
    }

    const usedModel = r.completion.model || currentModel;
    if (usedModel && usedModel !== lastModel) {
      onProgress({ phase: "info", team, model: usedModel, summary: `Model: ${usedModel}`, round });
      lastModel = usedModel;
    }

    const msg = r.completion.choices?.[0]?.message;
    if (!msg) {
      onProgress({ phase: "error", team, summary: "The model returned nothing." });
      return { status: "error", summary: "empty completion" };
    }

    const think = extractThink(msg.content);
    if (think) onProgress({ phase: "thinking", team, summary: think.slice(0, 240), round });

    const calls = msg.tool_calls || [];

    if (!calls.length) {
      const text = clean(msg.content);
      if (text) onProgress({ phase: "info", team, summary: text.slice(0, 400), round });
      if (text && text.includes(doneMarker)) {
        // Hard gate: execution can't finish until a build/test/typecheck has
        // actually passed this run. Nudge once, then allow it through so a
        // project with genuinely no verifiable command can't deadlock.
        if (phase === "executing" && !verifiedOnce && !verifyNudged) {
          verifyNudged = true;
          onProgress({ phase: "info", team, summary: "Not done yet — must verify with a build/test first.", round });
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
        await appendMemory(projectId, `**[${team}] Done.** ${summary}`);
        await syncPhaseDoc(projectId, phase, summary);
        onProgress({ phase: "done", team, summary });
        return { status: "done", summary };
      }
      messages.push(msg);
      messages.push({
        role: "user",
        content: `Continue. If the ${team} work is fully done, end with ${doneMarker}; otherwise take the next concrete step with a tool.`,
      });
      continue;
    }

    messages.push(msg);
    const memoryNotes: string[] = [];
    let repeatedCall = false;
    let stuck = false;
    for (const call of calls) {
      if (stopped()) return { status: "stopped", summary: "stopped by user" };
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* leave empty */ }
      if (args === null || typeof args !== "object") args = {};
      const name = call.function?.name || "";
      const d = describeCall(name, args);
      onProgress({ phase: "tool", team, tool: name, summary: d.summary, detail: d.detail, status: "running", round });

      const result = await execTool(projectId, name, args, prep.workdir);
      const good = ok(result);
      onProgress({ phase: "result", team, tool: name, summary: d.summary, detail: shortResult(result), status: good ? "ok" : "failed", round });
      memoryNotes.push(`${good ? "✓" : "✗"} ${d.summary}${d.detail ? ` — ${d.detail}` : ""}${good ? "" : ` (${shortResult(result)})`}`);
      // A build/test/typecheck that actually passed satisfies the verification gate.
      if (good && name === "run_shell" && VERIFY_RE.test(String(args?.command ?? ""))) verifiedOnce = true;
      // Durably record real failures so a re-run sees them (and the prompt tells
      // the model to clear error.md). Skip read-only browser/list noise.
      if (!good && (name === "run_shell" || name === "write_file" || name === "edit_file")) {
        await logError(projectId, `[${team}] ${d.summary}${d.detail ? ` (${d.detail})` : ""}: ${shortResult(result)}`);
      }

      const sig = `${name}|${JSON.stringify(args)}`;
      const count = (sigCounts.get(sig) || 0) + 1;
      sigCounts.set(sig, count);
      if (count >= REPEAT_NUDGE_AT) repeatedCall = true;
      if (count >= REPEAT_ABORT_AT) stuck = true;

      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, TOOL_RESULT_CAP) });
      toolMeta.push({ idx: messages.length - 1, round, brief: `${good ? "✓" : "✗"} ${d.summary}${d.detail ? ` (${d.detail})` : ""}` });
    }
    if (memoryNotes.length) await appendMemory(projectId, `[${team}] Step ${round}:\n${memoryNotes.join("\n")}`);

    if (stuck) {
      await appendMemory(projectId, `**[${team}] Stuck.** Repeated a call ${REPEAT_ABORT_AT}× on ${currentModel}.`);
      if (escalate("stuck repeating a call")) continue;
      onProgress({ phase: "error", team, summary: "Stuck repeating a call and no other model is available — stopped." });
      return { status: "error", summary: "stuck in a repeat loop" };
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

  await appendMemory(projectId, `**[${team}] Paused** after ${MAX_ROUNDS} steps (cap reached).`);
  onProgress({ phase: "info", team, summary: `Reached the ${MAX_ROUNDS}-step limit.` });
  return { status: "capped", summary: "step cap reached" };
}
