"use client";

// Client-driven LOCAL turn — "Hermes = brain, JARVIS = face".
//
// When the local computer is on and Hermes Agent (nousresearch/hermes-agent) is
// installed, a local/hybrid voice turn is handed straight to Hermes: the browser
// posts the utterance to the bridge's /hermes/run, which runs `hermes -z "<text>"`
// (Hermes' pure one-shot mode) and returns the final reply. Hermes does ALL the
// thinking, tools, skills and memory itself; its LLM provider is configured
// inside Hermes (provider: custom → a local freellmapi base_url), so free-tier
// key rotation lives there. JARVIS just relays the utterance and shows/speaks the
// answer. The browser orchestrates because only it can reach the localhost bridge.
//
// The result is shaped exactly like the /api/voice response so the existing
// VoiceButton handler (processAgentResponse) drives it unchanged.
//
// NOTE: bridgeChat / execBrowserTool / BROWSER_TOOLS below are retained for
// CODING mode (lib/coding-agent.ts), which still drives its own tool loop over
// an OpenAI-compatible local backend. They are not used on the Hermes voice path.

import { getBridgeUrl, getBridgeToken, pageOpen, pageSnapshot, pageText, pageAct, pageScroll } from "./bridge";
import type { LocalStatus } from "./local-presence";
import { getEnabledLocalToolNames } from "./tool-config";
import { publishModel, logRoute } from "./model-hud";

const MODEL_KEY = "local.model";

// Abort a fetch that never responds so a stuck local turn can't freeze the HUD
// on "thinking…" forever — it surfaces as an error and the caller falls back to
// the cloud path. prep is quick (prompt build); a router turn may rotate several
// models, so it gets a longer leash.
function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// Agentic browser tools run on the bridge CLIENT-SIDE (Vercel can't reach
// localhost). Used by Coding mode's tool loop.
export const BROWSER_TOOLS = new Set(["browser_open", "browser_snapshot", "browser_scroll", "browser_act", "browser_read"]);

function normalizeBrowserUrl(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  const markdownMatch = raw.match(/\[[^\]]*?(https?:\/\/[^\]\s"')]+)[^\]]*?\]\((https?:\/\/[^)\s]+)\)/i);
  const candidate = markdownMatch?.[1] || raw.match(/https?:\/\/[^\s\])}>"']+/i)?.[0] || raw;
  let url = candidate
    .trim()
    .replace(/\\+$/g, "")
    .replace(/[)\]}>"']+$/g, "");

  try {
    url = decodeURIComponent(url);
  } catch {
    /* keep the original candidate */
  }

  url = url.replace(/["')\]}]+$/g, "");
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(url)) url = `https://${url}`;
  return /^https?:\/\//i.test(url) ? url : "";
}

export async function execBrowserTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "browser_open": {
      const url = normalizeBrowserUrl(args?.url);
      if (!url) return { ok: false, error: "no url given" };
      return await pageOpen(url);
    }
    case "browser_snapshot":
      return await pageSnapshot();
    case "browser_read":
      return await pageText();
    case "browser_scroll": {
      const rawDirection = String(args?.direction ?? "down").toLowerCase();
      const direction = rawDirection === "up" ? "up" : "down";
      const amount = Number(args?.amount);
      return await pageScroll(direction, Number.isFinite(amount) ? amount : undefined);
    }
    case "browser_act": {
      const action = String(args?.action ?? "");
      if (!["click", "type", "select", "check", "back", "enter"].includes(action)) {
        return { ok: false, error: `unknown browser_act action "${action}"; use browser_scroll for scrolling` };
      }
      return await pageAct(
        action as "click" | "type" | "select" | "check" | "back" | "enter",
        args?.ref != null ? args.ref : undefined,
        args?.text != null ? String(args.text) : undefined
      );
    }
    default:
      return { ok: false, error: `unknown browser tool ${name}` };
  }
}

// Clear short-term transcript (kept for VoiceButton's live-conversation end).
// Hermes keeps its own persistent memory, so the voice path doesn't manage chat
// history here; this just clears the legacy key.
const HISTORY_KEY = "local.history";
export function clearLocalHistory() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* best-effort */
  }
}

// Retained for Coding mode's model picker (Coding.tsx) — the freellmapi model id
// it drives. Not used by the Hermes voice path (Hermes owns its own model).
export function getLocalModel(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(MODEL_KEY) || "";
}
export function setLocalModel(model: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(MODEL_KEY, model);
}

// Same intent/contract as the cloud /api/voice JSON, so callers can reuse it.
export type AgentResponse = {
  transcript: string;
  reply: string;
  actions: { name: string; args: any; result: unknown }[];
  model: string;
  models: string[];
  exhausted: string[];
  usage?: { prompt: number; completion: number; total: number };
  routed: boolean;
  routing: unknown;
  error?: string;
};

// Proxy an OpenAI-shaped chat completion to the bridge's local backend
// (freellmapi). Used by CODING mode's tool loop, not the Hermes voice path.
export async function bridgeChat(body: object): Promise<{ ok: boolean; completion?: any; error?: string }> {
  try {
    const res = await fetch(`${getBridgeUrl()}/local/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getBridgeToken()}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `local model error (${res.status})` };
    return data;
  } catch {
    return { ok: false, error: "Couldn't reach the local model. Is freellmapi running?" };
  }
}

// Proxy an OpenAI-shaped chat completion to JARVIS's OWN rotating router
// (lib/llm-router.ts via /api/v1/chat/completions). Same-origin, so the browser
// can reach it directly — no localhost bridge / freellmapi needed. `model` must
// be "<platform>/<model-id>" (e.g. "groq/openai/gpt-oss-120b"). Used by the
// Pipeline loop. Returns the same shape as bridgeChat so callers are unchanged.
export async function routerChat(
  body: object,
  signal?: AbortSignal
): Promise<{ ok: boolean; completion?: any; error?: string }> {
  try {
    const res = await fetch(`/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error?.message || data?.error || `router error (${res.status})`;
      return { ok: false, error: typeof err === "string" ? err : `router error (${res.status})` };
    }
    return { ok: true, completion: data };
  } catch {
    return { ok: false, error: "Couldn't reach the LLM router (/api/v1). Is the app server running?" };
  }
}

// Hermes runs its inference through JARVIS's OWN rotating router (/api/v1), and
// that proxy emits a "tokens" event per upstream call into the router-feed ring
// (lib/router-feed.ts). `hermes -z` never reports usage back to us, so to make
// the HUD's token count work for a LOCAL turn we sum the token events that landed
// during the turn's time window and attribute them to it. A turn that didn't hit
// /api/v1 (Hermes pointed at a different backend) simply yields no events → no
// count, exactly as before. Same-process only (browser + /api/v1 share origin).
async function sumRouterUsageSince(
  sinceMs: number
): Promise<{ prompt: number; completion: number; total: number } | undefined> {
  try {
    const res = await fetch(`/api/router-feed`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    const events = Array.isArray(data?.events) ? data.events : [];
    let prompt = 0,
      completion = 0,
      total = 0,
      any = false;
    // Small margin so minor browser↔server clock skew can't drop the first event.
    // Safe against bleeding a prior turn in: turns are seconds apart, not <1.5s.
    const cutoff = sinceMs - 1500;
    for (const e of events) {
      if (e?.kind === "tokens" && typeof e.at === "number" && e.at >= cutoff) {
        prompt += e.prompt || 0;
        completion += e.completion || 0;
        total += e.total || 0;
        any = true;
      }
    }
    return any ? { prompt, completion, total } : undefined;
  } catch {
    return undefined;
  }
}

// Dispatch ONE native tool call for the local loop. Browser tools drive the
// user's logged-in Chromium and can only run client-side (via the bridge); every
// other tool runs server-side against the cloud DB / APIs through /api/agent/tool
// (the SAME runTool the cloud path uses), so a LOCAL turn behaves identically —
// pending local actions (open_app / run_shell / WhatsApp) come back as the same
// `{ local_action, pending }` intents the existing confirm flow already handles.
async function dispatchLocalTool(name: string, args: any): Promise<unknown> {
  // Authoritative enforcement of the deck's tool picker: even if a model somehow
  // names a tool that isn't in its schema, a turned-off tool NEVER executes.
  if (!new Set(getEnabledLocalToolNames()).has(name)) {
    return { error: `the "${name}" tool is turned off in your tool settings.` };
  }
  if (BROWSER_TOOLS.has(name)) {
    try {
      return await execBrowserTool(name, args);
    } catch (e: any) {
      return { error: e?.message || "browser tool failed" };
    }
  }
  try {
    const res = await fetch(`/api/agent/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error || `tool failed (${res.status})` };
    return data.result;
  } catch {
    return { error: "couldn't reach the tool runner" };
  }
}

const MAX_LOCAL_ROUNDS = 8;

function shortLocalResult(a: AgentResponse["actions"][number]): string {
  const raw = JSON.stringify(a.result);
  const result = raw && raw.length > 900 ? `${raw.slice(0, 900)}...` : raw || "";
  return `- ${a.name} ${JSON.stringify(a.args ?? {})} -> ${result}`;
}

function localContinuationPrompt(text: string, actions: AgentResponse["actions"]): any[] {
  return [
    {
      role: "system",
      content:
        "You are JARVIS at a no-tools checkpoint. Decide if the user's full request is complete from the tool results. If more tool work is still needed and the prior tools succeeded, reply exactly `MORE_TOOLS: <brief next step>`. For browser tasks where the user asked what you find on a page, do not answer `Done`; use browser_read content, a useful snapshot returned by browser_open/browser_scroll/browser_act/browser_snapshot, or a concrete browser failure to report. Do not call browser_read just to check whether a click worked when browser_act already returned a snapshot. If browser_act says a target is missing, continue with MORE_TOOLS and call browser_scroll to reveal more refs before retrying; scroll at most twice in one request, then act/read/answer from what is visible. Do not quote raw snapshot text or read element labels as a list; interpret the snapshot like a person and speak naturally about what is visible or what still needs to be clicked. If a required non-recoverable tool failed, explain the failure briefly instead of retrying the same tool. Otherwise reply naturally in one short spoken sentence. Do not invent tool results.",
    },
    {
      role: "user",
      content: `The user said: "${text}".\n\nTool results:\n${actions.map(shortLocalResult).join("\n")}`,
    },
  ];
}

function browserTaskNeedsSubstance(text: string): boolean {
  return /\b(open|go to|website|page|courses?|filter|search|find|tell me|what (?:do|does|did|is|are)|read)\b/i.test(text);
}

function weakBrowserDoneReply(reply: string): boolean {
  return /^(done|ok(?:ay)?|finished|completed)\.?$/i.test(reply.trim());
}

function looksLikeBareBrowserToolNameReply(reply: string): boolean {
  return /^browser_(?:open|snapshot|act|read)\.?$/i.test(reply.trim());
}

function looksLikeRawBrowserSnapshotReply(reply: string): boolean {
  const text = reply.replace(/\s+/g, " ").trim();
  if (text.length < 80 || text.length > 1200) return false;
  const hasSnapshotLabels = /\b(Search|Filter by|Schools|Interests|Select School|School of Computing|Showing \d+)/i.test(text);
  const hasNaturalSentence = /[.!?]\s+[A-Z]/.test(text);
  return hasSnapshotLabels && !hasNaturalSentence;
}

function browserFallbackReply(text: string, actions: AgentResponse["actions"]): string {
  if (!browserTaskNeedsSubstance(text)) return "Done.";
  const browserActions = actions.filter((a) => String(a.name).startsWith("browser_"));
  const lastError = [...browserActions]
    .reverse()
    .map((a) => (a.result as any)?.error || (a.result as any)?.snapshotError)
    .find(Boolean);
  if (lastError) return `I couldn't finish that browser task: ${String(lastError)}`;
  const read = [...browserActions].reverse().find((a) => a.name === "browser_read" && (a.result as any)?.content);
  if (read) {
    const content = String((read.result as any).content || "").replace(/\s+/g, " ").trim();
    return content ? content.slice(0, 220) : "I opened the page, but couldn't extract a useful result yet.";
  }
  const snapshotText = [...browserActions]
    .reverse()
    .map((a) => String((a.result as any)?.snapshot?.tree || (a.result as any)?.tree || ""))
    .find(Boolean);
  if (snapshotText && /\bFilter by\b/i.test(snapshotText)) {
    return "I can see the course filter area, but I couldn't confirm the filtered course results yet.";
  }
  return "I opened the page, but couldn't confirm the filtered results from the browser yet.";
}

// Run a full voice turn on JARVIS's OWN native tool loop (no Hermes). The browser
// asks /api/agent/prep for the routed system prompt + the user-enabled toolset,
// then runs the tool-calling loop against the native rotating router (/api/v1 →
// lib/llm-router.ts) — dispatching each call via dispatchLocalTool — until the
// model produces a spoken reply. Inference is the native router; the bridge is
// only used for browser/local-action tools. The result is shaped exactly like the
// /api/voice JSON so VoiceButton.processAgentResponse drives it unchanged.
export async function runLocalTurn(
  text: string,
  presence: LocalStatus,
  opts: { userProfile?: string; useSnapshot?: boolean }
): Promise<AgentResponse> {
  const base: AgentResponse = {
    transcript: text,
    reply: "",
    actions: [],
    model: "local",
    models: ["local"],
    exhausted: [],
    routed: false,
    routing: null,
  };

  // Mark the start so we can attribute this turn's /api/v1 token events (the loop
  // routes through our router) back to it for the HUD's token count.
  const startedAt = Date.now();

  // 1) Server builds the routed prompt + the enabled toolset (client-only state,
  //    so the list of enabled tools is sent up).
  let prep: {
    system: string;
    tools: any[];
    chat: boolean;
    onlyPreset: boolean;
    presetCalls: { name: string; args: any }[];
    error?: string;
  };
  logRoute("jarvis", "▸ local turn → preparing (tools + snapshot)…");
  const prepTimer = withTimeout(25_000);
  try {
    const res = await fetch(`/api/agent/prep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        userProfile: opts.userProfile || "",
        useSnapshot: opts.useSnapshot !== false,
        allTools: true,
        enabledTools: getEnabledLocalToolNames(),
      }),
      signal: prepTimer.signal,
    });
    prep = await res.json().catch(() => ({} as any));
    if (!res.ok || prep.error) {
      const err = prep?.error || `couldn't prepare the local turn (${res.status})`;
      return { ...base, reply: err, error: err };
    }
  } catch (e: any) {
    const err =
      e?.name === "AbortError"
        ? "Preparing the local turn timed out."
        : "Couldn't reach the app server to prepare the turn.";
    return { ...base, reply: err, error: err };
  } finally {
    prepTimer.done();
  }

  const messages: any[] = [
    { role: "system", content: prep.system },
    { role: "user", content: text },
  ];
  const actions: AgentResponse["actions"] = [];

  // 2) Deterministic preset calls (bulk delete/complete) — run them straight.
  if (prep.onlyPreset && prep.presetCalls.length) {
    for (const c of prep.presetCalls) {
      const result = await dispatchLocalTool(c.name, c.args ?? {});
      actions.push({ name: c.name, args: c.args ?? {}, result });
    }
    const usage = await sumRouterUsageSince(startedAt);
    return { ...base, reply: "Done.", actions, ...(usage ? { usage } : {}) };
  }

  // 3) The tool-calling loop. `model: "auto"` lets the router rotate the key pool.
  let reply = "";
  let lastModel = ""; // the actual model the router landed on (for the HUD + usage)
  let needToolRound = !prep.chat && prep.tools.length > 0;
  let attemptedBrowserOpenThisTurn = false;
  let browserScrollsThisTurn = 0;
  for (let round = 0; round < MAX_LOCAL_ROUNDS; round++) {
    const shouldUseTools = needToolRound;
    const roundTools = shouldUseTools ? prep.tools : [];
    const body: any = {
      model: "auto",
      messages: roundTools.length ? messages : actions.length ? localContinuationPrompt(text, actions) : messages,
    };
    if (roundTools.length) {
      body.tools = roundTools;
      body.tool_choice = "auto";
    }
    const roundTimer = withTimeout(60_000);
    let r: { ok: boolean; completion?: any; error?: string };
    try {
      r = await routerChat(body, roundTimer.signal);
    } finally {
      roundTimer.done();
    }
    if (!r.ok) {
      const err = r.error || "the local router failed";
      return { ...base, reply: err, error: err };
    }
    // Surface the model the router actually chose so the HUD shows what's
    // currently thinking on a LOCAL turn (not just the placeholder "local").
    const picked = String(r.completion?.model ?? "").trim();
    if (picked) {
      lastModel = picked;
      publishModel("jarvis", `local:${picked}`, "thinking…", true);
    }
    const msg = r.completion?.choices?.[0]?.message;
    if (!msg) break;
    if (!roundTools.length) {
      const content = String(msg.content ?? "").trim();
      if (/^MORE_TOOLS\b/i.test(content)) {
        needToolRound = !prep.chat && prep.tools.length > 0;
        messages.push({
          role: "user",
          content: `Continue the original request. The no-tools checkpoint said more tool work is needed: ${content.replace(/^MORE_TOOLS:?\s*/i, "")}`,
        });
        continue;
      }
      if (looksLikeBareBrowserToolNameReply(content) && actions.some((a) => String(a.name).startsWith("browser_"))) {
        needToolRound = !prep.chat && prep.tools.length > 0;
        messages.push({
          role: "user",
          content: `Continue the original browser task. The no-tools checkpoint replied with a tool name (${content}); call the needed browser tool instead of saying its name.`,
        });
        continue;
      }
      if (
        (weakBrowserDoneReply(content) || looksLikeRawBrowserSnapshotReply(content)) &&
        actions.some((a) => String(a.name).startsWith("browser_"))
      ) {
        reply = browserFallbackReply(text, actions);
        break;
      }
      reply = content;
      break;
    }
    messages.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      reply = String(msg.content ?? "").trim();
      break;
    }
    for (const call of calls) {
      const name = String(call?.function?.name ?? "");
      let args: any = {};
      try {
        args = JSON.parse(call?.function?.arguments || "{}");
      } catch {
        args = {};
      }
      if (name === "browser_open") {
        const cleanUrl = normalizeBrowserUrl(args?.url);
        if (cleanUrl) args = { ...args, url: cleanUrl };
      }
      let result: unknown;
      if (name === "browser_open" && attemptedBrowserOpenThisTurn) {
        result = {
          ok: false,
          error:
            "browser_open has already been attempted in this turn. Use browser_snapshot, browser_scroll, browser_act, or browser_read on the current page instead of opening another page.",
        };
      } else if (name === "browser_scroll" && browserScrollsThisTurn >= 2) {
        result = {
          ok: false,
          error:
            "browser_scroll has already been used twice in this turn. Use the latest snapshot to call browser_act, browser_read, or answer what is visible instead of scrolling again.",
        };
      } else {
        if (name === "browser_open") attemptedBrowserOpenThisTurn = true;
        if (name === "browser_scroll") browserScrollsThisTurn++;
        result = await dispatchLocalTool(name, args);
      }
      actions.push({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
    needToolRound = false;
  }

  const finalReply =
    reply && !weakBrowserDoneReply(reply) && !looksLikeBareBrowserToolNameReply(reply) && !looksLikeRawBrowserSnapshotReply(reply)
      ? reply
      : browserFallbackReply(text, actions);

  // Record this turn into JARVIS's Obsidian state (memory.md / decision.md /
  // activity.md) — fire-and-forget, never blocks the reply. Server-side fs only,
  // so it's a no-op on the cloud deploy.
  fetch(`/api/agent/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      user: text,
      assistant: finalReply,
      actions: actions.map((a) => ({ name: a.name, args: a.args })),
    }),
  }).catch(() => {});

  const usage = await sumRouterUsageSince(startedAt);
  const model = lastModel || "local";
  // Tag the model as local-origin so the HUD/warm-up treats it as a local turn
  // (no cloud re-warm) while still showing the real model id the router used.
  const hudModel = lastModel ? `local:${lastModel}` : "local";
  return {
    ...base,
    reply: finalReply,
    model: hudModel,
    models: [hudModel],
    routed: true,
    actions,
    ...(usage ? { usage } : {}),
    routing: { local: true, model, tools: actions.map((a) => a.name) },
  };
}
