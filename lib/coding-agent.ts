"use client";

// The autonomous CODING loop (client-driven). In coding mode the assigned local
// model works on a project's task on its OWN — thinking, calling tools, checking
// its work — until it declares the task complete, hits the round cap, or the user
// stops it. The loop runs in the browser because only the browser can reach the
// localhost bridge (Ollama + run_shell + the controlled browser); the local Next
// server holds the project files and runs the scoped file tools.
//
// Each step is surfaced live via onProgress so the UI shows exactly what the agent
// is executing and doing, and a concise note is appended to the project's memory.md.

import { bridgeChat, execBrowserTool, BROWSER_TOOLS } from "./local-agent";
import { runShell } from "./bridge";

// File-tool names handled by /api/coding/tool. Defined here (not imported from
// lib/tools.ts) so this client module never pulls in server-only deps.
const CODING_FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file", "list_dir"]);

const MAX_CODING_ROUNDS = 30;

export type CodingPhase = "thinking" | "tool" | "result" | "review" | "done" | "error" | "info";
export type CodingEvent = {
  phase: CodingPhase;
  summary: string; // one-line human-readable description
  detail?: string; // optional extra (command, file, error text)
  tool?: string;
  status?: "running" | "ok" | "failed";
  round?: number;
};

type Progress = (e: CodingEvent) => void;

// Order local models strongest-first by their parameter size parsed from the name
// (e.g. "gpt-oss:120b" → 120, "…-20b" → 20). Names with no size sort last. This is
// the best-first chain the loop tries: the strongest model goes first and we only
// fall to weaker ones if it fails or gets stuck.
export function rankModelsByStrength(models: string[]): string[] {
  const size = (m: string): number => {
    const matches = [...m.matchAll(/(\d+(?:\.\d+)?)\s*b\b/gi)];
    return matches.length ? Math.max(...matches.map((x) => parseFloat(x[1]))) : 0;
  };
  return [...new Set(models)].filter(Boolean).sort((a, b) => size(b) - size(a));
}

// A human-readable "what it's about to do" line for a tool call.
function describeCall(name: string, args: any): { summary: string; detail?: string } {
  const a = args || {};
  switch (name) {
    case "list_dir": return { summary: `Listing ${a.path || "the project folder"}` };
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

// Execute one tool call, routing by name: coding file tools → /api/coding/tool;
// browser_* → the bridge; run_shell → the bridge; anything else → /api/agent/tool.
async function execCodingTool(projectId: string, name: string, args: any): Promise<any> {
  try {
    if (CODING_FILE_TOOL_NAMES.has(name)) {
      const res = await fetch("/api/coding/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name, args }),
      });
      const data = await res.json().catch(() => ({}));
      return data.result ?? { ok: false, error: "file tool failed" };
    }
    if (BROWSER_TOOLS.has(name)) {
      return await execBrowserTool(name, args);
    }
    if (name === "run_shell") {
      const r = await runShell(String(args?.command ?? ""));
      return r.ok
        ? { ok: true, message: r.message, output: r.output ?? "" }
        : { ok: false, error: r.message };
    }
    // Fallback: a productivity/DB tool, executed server-side like the local loop.
    const res = await fetch("/api/agent/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? data.result : { error: data.error || "tool failed" };
  } catch (e: any) {
    return { ok: false, error: e?.message || "tool execution failed" };
  }
}

function ok(result: any): boolean {
  return !(result && (result.ok === false || result.error));
}
function shortResult(result: any): string {
  if (result == null) return "";
  if (result.error) return String(result.error);
  if (result.message) return String(result.message);
  if (typeof result === "object") return JSON.stringify(result).slice(0, 200);
  return String(result).slice(0, 200);
}

function extractThink(s?: string | null): string {
  const m = (s || "").match(/<think>([\s\S]*?)<\/think>/i);
  return (m?.[1] || "").trim();
}
function clean(s?: string | null): string {
  return (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

async function appendMemory(projectId: string, entry: string) {
  try {
    await fetch("/api/coding/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, entry }),
    });
  } catch {
    /* best-effort */
  }
}

async function setStatus(projectId: string, status: string) {
  try {
    await fetch(`/api/coding/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  } catch {
    /* best-effort */
  }
}

export type CodingResult = { status: "done" | "stopped" | "error" | "capped"; summary: string };

// Run the autonomous coding loop for a project. Resolves when the agent finishes,
// is stopped (signal), errors, or hits the round cap.
export async function runCodingTask(
  projectId: string,
  opts: { onProgress: Progress; signal?: AbortSignal; availableModels?: string[] }
): Promise<CodingResult> {
  const { onProgress, signal } = opts;
  const stopped = () => signal?.aborted;

  // 1) Prep: coding system prompt + tools from the server.
  let prep: { system: string; tools: any[]; model: string; doneMarker: string };
  try {
    const res = await fetch("/api/coding/prep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId }),
    });
    prep = await res.json();
    if (!res.ok || !prep?.system) {
      onProgress({ phase: "error", summary: "Couldn't prepare the project." });
      return { status: "error", summary: "prep failed" };
    }
  } catch {
    onProgress({ phase: "error", summary: "Couldn't reach the server to prepare the project." });
    return { status: "error", summary: "prep unreachable" };
  }
  if (!prep.model) {
    onProgress({ phase: "error", summary: "No local model is assigned to this project." });
    return { status: "error", summary: "no model" };
  }

  await setStatus(projectId, "running");

  // Best-first model chain. With "auto" we drive rotation OURSELVES — strongest
  // model first — and escalate to the next only when one fails or gets stuck, so
  // weak models are a last resort and once the chain is exhausted we stop instead
  // of spinning. A pinned model is just a one-item chain. Falls back to "auto"
  // (let the bridge pick) only if we have no model list at all.
  const chain = prep.model === "auto"
    ? rankModelsByStrength(opts.availableModels || [])
    : [prep.model];
  if (!chain.length) chain.push("auto");
  let chainIdx = 0;
  let currentModel = chain[chainIdx];
  const rotating = chain.length > 1 || currentModel === "auto";
  onProgress({
    phase: "info",
    summary: rotating
      ? `Starting — best model first${chain.length > 1 ? ` (${currentModel}, ${chain.length - 1} fallback${chain.length > 2 ? "s" : ""})` : ""}…`
      : `Starting with ${currentModel}…`,
  });
  // Track which model actually served each round so we can surface rotation.
  let lastModel = "";

  const messages: any[] = [
    { role: "system", content: prep.system },
    { role: "user", content: "Begin the task. Work autonomously and narrate what you're doing." },
  ];
  const doneMarker = prep.doneMarker || "TASK_COMPLETE";

  // Loop-breaker: weak local models tend to call the SAME read-only tool over and
  // over (e.g. list the same empty folder) and burn the whole step budget making
  // no progress. Count identical tool-call signatures and (a) nudge the model when
  // one repeats, (b) hard-stop if it gets truly stuck.
  const sigCounts = new Map<string, number>();
  const REPEAT_NUDGE_AT = 2; // after this many repeats of a call, push a corrective
  const REPEAT_ABORT_AT = 5; // a model that keeps repeating → escalate (or stop)

  // Move down the best-first chain to the next model, carrying full context. The
  // running `messages` array + memory.md mean the next model picks up where this
  // one left off. Returns false when the chain is exhausted — i.e. even the weakest
  // model couldn't handle it, so the caller stops.
  function escalate(reason: string): boolean {
    if (chainIdx >= chain.length - 1) return false;
    chainIdx++;
    currentModel = chain[chainIdx];
    lastModel = currentModel; // keep the per-round surfacing from double-announcing
    sigCounts.clear(); // fresh repeat budget for the new model
    onProgress({ phase: "review", summary: `↻ ${reason} — handing off to ${currentModel}` });
    appendMemory(projectId, `↻ Switched to ${currentModel} (${reason}); context carried over.`);
    messages.push({
      role: "user",
      content:
        "A different model is now taking over this task. Read the project memory and the work so far, then take the next concrete step toward the task. " +
        `When the task is genuinely done and self-reviewed, end with ${doneMarker}.`,
    });
    return true;
  }

  for (let round = 1; round <= MAX_CODING_ROUNDS; round++) {
    if (stopped()) { await setStatus(projectId, "idle"); onProgress({ phase: "info", summary: "Stopped." }); return { status: "stopped", summary: "stopped by user" }; }

    onProgress({ phase: "info", summary: `Thinking…`, round });
    const r = await bridgeChat({
      // We pin the CURRENT model from our best-first chain explicitly (rather than
      // "auto") so rotation is OURS to control: strongest first, escalate on
      // failure/stuck. sessionId keeps the bridge's context warm; the messages
      // array carries the real state across a model switch.
      model: currentModel,
      sessionId: projectId,
      messages,
      tools: prep.tools,
      tool_choice: "auto",
      temperature: 0.2,
      stream: false,
    });
    if (stopped()) { await setStatus(projectId, "idle"); return { status: "stopped", summary: "stopped by user" }; }
    if (!r.ok || !r.completion) {
      // This model errored — drop to the next in the chain; only give up if none left.
      if (escalate(r.error || "model error")) continue;
      await setStatus(projectId, "error");
      onProgress({ phase: "error", summary: r.error || "The local model didn't respond." });
      return { status: "error", summary: r.error || "model error" };
    }
    // Surface which model served this round; note rotations in the feed + memory.
    const usedModel = r.completion.model || (rotating ? "" : currentModel);
    if (usedModel && usedModel !== lastModel) {
      if (lastModel) {
        onProgress({ phase: "review", summary: `↻ Switched model → ${usedModel}`, round });
        await appendMemory(projectId, `↻ Switched model to ${usedModel} (context carried over).`);
      } else {
        onProgress({ phase: "info", summary: `Model: ${usedModel}`, round });
      }
      lastModel = usedModel;
    }

    const msg = r.completion.choices?.[0]?.message;
    if (!msg) {
      await setStatus(projectId, "error");
      onProgress({ phase: "error", summary: "The local model returned nothing." });
      return { status: "error", summary: "empty completion" };
    }

    const think = extractThink(msg.content);
    if (think) onProgress({ phase: "thinking", summary: think.slice(0, 240), round });

    const calls = msg.tool_calls || [];

    // No tool calls → the model is talking. Check for the done marker.
    if (!calls.length) {
      const text = clean(msg.content);
      if (text) onProgress({ phase: "info", summary: text.slice(0, 400), round });
      if (text && text.includes(doneMarker)) {
        const summary = text.replace(doneMarker, "").trim() || "Task complete.";
        await appendMemory(projectId, `**Done.** ${summary}`);
        await setStatus(projectId, "done");
        onProgress({ phase: "done", summary });
        return { status: "done", summary };
      }
      // Talked but didn't finish and didn't call a tool — nudge it to continue.
      messages.push(msg);
      messages.push({
        role: "user",
        content: `Continue. If the task is fully done and self-reviewed, end with ${doneMarker}; otherwise take the next concrete step with a tool.`,
      });
      continue;
    }

    // Execute each tool call, narrating before + after.
    messages.push(msg);
    const memoryNotes: string[] = [];
    let repeatedCall = false; // a call this round was a near-identical repeat
    let stuck = false; // a call hit the repeat-abort threshold this round
    for (const call of calls) {
      if (stopped()) { await setStatus(projectId, "idle"); return { status: "stopped", summary: "stopped by user" }; }
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* leave empty */ }
      if (args === null || typeof args !== "object") args = {};
      const name = call.function?.name || "";
      const d = describeCall(name, args);
      onProgress({ phase: "tool", tool: name, summary: d.summary, detail: d.detail, status: "running", round });

      const result = await execCodingTool(projectId, name, args);
      const good = ok(result);
      onProgress({
        phase: "result",
        tool: name,
        summary: d.summary,
        detail: shortResult(result),
        status: good ? "ok" : "failed",
        round,
      });
      memoryNotes.push(`${good ? "✓" : "✗"} ${d.summary}${d.detail ? ` — ${d.detail}` : ""}${good ? "" : ` (${shortResult(result)})`}`);

      // Track repeats of this exact call. Hard-stop if the model is truly stuck.
      const sig = `${name}|${JSON.stringify(args)}`;
      const count = (sigCounts.get(sig) || 0) + 1;
      sigCounts.set(sig, count);
      if (count >= REPEAT_NUDGE_AT) repeatedCall = true;
      if (count >= REPEAT_ABORT_AT) stuck = true;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
    // Record this round's actions to the project memory.
    if (memoryNotes.length) await appendMemory(projectId, `Step ${round}:\n${memoryNotes.join("\n")}`);

    // This model is stuck repeating a call with no progress. Hand off to the next
    // (weaker) model in the chain; only stop if even the weakest can't handle it.
    if (stuck) {
      await appendMemory(projectId, `**Stuck.** Repeated a call ${REPEAT_ABORT_AT}× with no progress on ${currentModel}.`);
      if (escalate("stuck repeating a call")) continue;
      await setStatus(projectId, "error");
      onProgress({ phase: "error", summary: `Stuck repeating a call and no other model is available — stopped. Try a clearer task, or enable run_shell so it can build/test.` });
      return { status: "error", summary: "stuck in a repeat loop" };
    }

    // If the model is re-running a call it already ran, steer it forward instead of
    // letting it spin on read-only exploration.
    if (repeatedCall) {
      messages.push({
        role: "user",
        content:
          "You are repeating tool calls you have already run and seen the result of. STOP re-exploring. " +
          "Take a new concrete step toward the task now: write_file or edit_file to create/change code, or run_shell to build/test. " +
          `If you are blocked (e.g. you need run_shell but it's disabled, or the folder is empty and you must scaffold it), say exactly what's blocking you. When the task is genuinely done, end with ${doneMarker}.`,
      });
    }
  }

  // Hit the round cap still working.
  await setStatus(projectId, "idle");
  await appendMemory(projectId, `**Paused** after ${MAX_CODING_ROUNDS} steps (cap reached).`);
  onProgress({ phase: "info", summary: `Reached the ${MAX_CODING_ROUNDS}-step limit — hit Continue to keep going.` });
  return { status: "capped", summary: "step cap reached" };
}
