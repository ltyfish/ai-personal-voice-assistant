// Built-in rotating LLM proxy — the native, serverless replacement for the
// FreeLLMAPI container. Takes an OpenAI-style chat-completions request, picks a
// free-tier key for the requested provider (round-robin = least-recently-used,
// skipping keys in cooldown), forwards it, and fails over to the next key on a
// 429 / 5xx / network error. State that FreeLLMAPI kept in a background loop
// (which key is rate-limited) lives in the `llm_keys.cooldown_until` column
// instead, so this runs fine on Vercel serverless.
//
// Model format: "<platform>/<model-id>" — the first path segment selects the
// provider, the remainder is passed upstream as the model. This stays
// unambiguous even for OpenRouter ids that themselves contain "/":
//   "openrouter/meta-llama/llama-3.3-70b-instruct:free"
//     -> platform=openrouter, model="meta-llama/llama-3.3-70b-instruct:free"

import { and, eq, isNull, or, lte, sql } from "drizzle-orm";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, llmKeys, llmModels, llmUsage, mailKv } from "@/db";
import type { LlmKey } from "@/db";
import { getRouterConfig } from "./router-config";
import { pushRouterEvent } from "./router-feed";
import { byBestModel } from "./model-rank";

type ProviderConfig = {
  baseUrl: string;
  keyless?: boolean;
  extraHeaders?: Record<string, string>;
};

// Base URLs mirror FreeLLMAPI's provider registry. google + cohere use their
// OpenAI-compatibility endpoints so the same passthrough works for every
// provider. cloudflare has no fixed base URL because the account-id lives in the
// path — each cloudflare key stores its own account-specific baseUrl (built in
// the Keys UI from the account id), exactly like a 'custom' key.
export const PROVIDERS: Record<string, ProviderConfig> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    extraHeaders: { "HTTP-Referer": "https://jarvis.app", "X-Title": "JARVIS" },
  },
  github: { baseUrl: "https://models.github.ai/inference" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  huggingface: { baseUrl: "https://router.huggingface.co/v1" },
  ollama: { baseUrl: "https://ollama.com/v1" },
  opencode: { baseUrl: "https://opencode.ai/zen/v1" },
  kilo: { baseUrl: "https://api.kilo.ai/api/gateway/v1", keyless: true },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  cohere: { baseUrl: "https://api.cohere.ai/compatibility/v1" },
  // Cloudflare Workers AI OpenAI-compatible endpoint. baseUrl is per-key:
  //   https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1
  // Auth is a plain Bearer API token (the account id rides the path, not the key).
  cloudflare: { baseUrl: "" },
  custom: { baseUrl: "" }, // baseUrl comes from the key row
};

export function listPlatforms(): string[] {
  return Object.keys(PROVIDERS);
}

// How long a key sits out after a failure before the router tries it again.
// serverError / network are short fixed back-offs (transient). rateLimit (429/
// 413) and client errors (4xx) are user-tunable via router-config — see Budget.
const COOLDOWN_MS = { serverError: 20_000, network: 30_000 };
const JARVIS_VAULT =
  process.env.JARVIS_VAULT || "C:\\Users\\User\\Downloads\\Projects\\Jarvis Personal AI";
const ROUTER_COOLDOWNS_FILE = join(JARVIS_VAULT, "Router Cooldowns.md");
const FAILURE_MARKER = "## Recent router failures";
const MODEL_COOLDOWN_NS = "router_model_cooldown";

type CooldownLogKind = "rate_limit" | "client_error" | "server_error" | "network" | "model_cooldown" | "model_skip";

function appendRouterCooldownLog(e: {
  kind: CooldownLogKind;
  model: string;
  key?: string;
  status?: number;
  detail: string;
  cooldownMs: number;
}) {
  try {
    mkdirSync(dirname(ROUTER_COOLDOWNS_FILE), { recursive: true });
    if (!existsSync(ROUTER_COOLDOWNS_FILE)) {
      writeFileSync(
        ROUTER_COOLDOWNS_FILE,
        `# JARVIS — Router Cooldowns\n\n${FAILURE_MARKER}\n\n`,
        "utf8",
      );
    } else {
      const text = readFileSync(ROUTER_COOLDOWNS_FILE, "utf8");
      if (!text.includes(FAILURE_MARKER)) {
        appendFileSync(ROUTER_COOLDOWNS_FILE, `\n\n${FAILURE_MARKER}\n\n`, "utf8");
      }
    }
    const mins = Math.max(1, Math.round(e.cooldownMs / 60_000));
    const bits = [
      new Date().toLocaleString("en-SG", { hour12: false }),
      e.kind,
      e.model,
      e.key ? `key ${e.key}` : "",
      e.status ? `status ${e.status}` : "",
      `${mins} min cooldown`,
      e.detail,
    ].filter(Boolean);
    appendFileSync(ROUTER_COOLDOWNS_FILE, `- ${bits.join(" · ")}\n`, "utf8");
  } catch {
    /* vault logging is best-effort */
  }
}

// Shared per-request routing settings. The router deliberately walks EVERY
// available key for the current model before moving to the next AUTO_CHAIN model;
// timeoutMs is the hard ceiling on each individual upstream call.
type Budget = {
  timeoutMs: number;
  cdRateLimit: number;
  cdClientError: number;
};
function newBudget(
  timeoutMs: number,
  cdRateLimit: number,
  cdClientError: number,
): Budget {
  return { timeoutMs, cdRateLimit, cdClientError };
}

function splitModel(model: string): { platform: string; upstreamModel: string } | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;
  const platform = model.slice(0, slash);
  const upstreamModel = model.slice(slash + 1);
  if (!PROVIDERS[platform] || !upstreamModel) return null;
  return { platform, upstreamModel };
}

// Enabled, not-in-cooldown keys for a platform, least-recently-used first. This
// spreads requests across every key for the model instead of sticking to one
// warm key. Never-used keys go first, so fresh imports join the rotation
// immediately.
async function candidateKeys(platform: string): Promise<LlmKey[]> {
  const now = new Date();
  return db
    .select()
    .from(llmKeys)
    .where(
      and(
        eq(llmKeys.platform, platform),
        eq(llmKeys.enabled, true),
        or(isNull(llmKeys.cooldownUntil), lte(llmKeys.cooldownUntil, now)),
      ),
    )
    .orderBy(sql`${llmKeys.lastUsedAt} ASC NULLS FIRST`);
}

// Live per-platform key availability, for the deck + the Obsidian Model Status
// mirror: how many enabled keys a platform has and how many are usable RIGHT NOW
// (not in cooldown). A platform with keys but zero available is "rate-limited /
// cooling" — its models can't run until `soonestResetAt`. Best-effort.
export async function getPlatformAvailability(): Promise<
  Record<string, { total: number; available: number; soonestResetAt: string | null }>
> {
  const rows = await db
    .select({ platform: llmKeys.platform, cooldownUntil: llmKeys.cooldownUntil })
    .from(llmKeys)
    .where(eq(llmKeys.enabled, true));
  const now = Date.now();
  const out: Record<string, { total: number; available: number; soonestResetAt: string | null }> = {};
  for (const k of rows) {
    const p = k.platform;
    const slot = (out[p] ??= { total: 0, available: 0, soonestResetAt: null });
    slot.total++;
    const cool = k.cooldownUntil ? new Date(k.cooldownUntil).getTime() : 0;
    if (!cool || cool <= now) {
      slot.available++;
    } else if (!slot.soonestResetAt || cool < new Date(slot.soonestResetAt).getTime()) {
      slot.soonestResetAt = new Date(cool).toISOString();
    }
  }
  return out;
}

async function markUsed(id: string) {
  await db
    .update(llmKeys)
    .set({ lastUsedAt: new Date(), failCount: 0 })
    .where(eq(llmKeys.id, id));
}

async function markCooldown(id: string, ms: number) {
  await db
    .update(llmKeys)
    .set({
      cooldownUntil: new Date(Date.now() + ms),
      failCount: sql`${llmKeys.failCount} + 1`,
    })
    .where(eq(llmKeys.id, id));
}

function normalizeModelCooldownId(model: string) {
  const cleaned = String(model || "").toLowerCase().replace(/:free$/, "");
  if (cleaned.includes("gpt-oss-120b")) return "gpt-oss-120b";
  if (cleaned.includes("gpt-oss-20b")) return "gpt-oss-20b";
  if (cleaned.includes("llama-3.3-70b")) return "llama-3.3-70b";
  if (cleaned.includes("qwen3-32b")) return "qwen3-32b";
  if (cleaned.includes("gemini-2.5-flash-lite")) return "gemini-2.5-flash-lite";
  if (cleaned.includes("gemini-2.5-flash")) return "gemini-2.5-flash";
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function modelCooldownKey(_platform: string, model: string) {
  return normalizeModelCooldownId(model);
}

async function getModelCooldown(
  platform: string,
  model: string,
): Promise<{ until: Date; detail: string } | null> {
  try {
    const key = modelCooldownKey(platform, model);
    const rows = await db
      .select({ value: mailKv.value })
      .from(mailKv)
      .where(and(eq(mailKv.namespace, MODEL_COOLDOWN_NS), eq(mailKv.key, key)))
      .limit(1);
    let value = rows[0]?.value as { until?: string; detail?: string } | undefined;
    if (!value) {
      const legacyKey = `${platform}/${model}`;
      const legacyRows = await db
        .select({ value: mailKv.value })
        .from(mailKv)
        .where(and(eq(mailKv.namespace, MODEL_COOLDOWN_NS), eq(mailKv.key, legacyKey)))
        .limit(1);
      value = legacyRows[0]?.value as { until?: string; detail?: string } | undefined;
    }
    const untilMs = value?.until ? new Date(value.until).getTime() : 0;
    if (!untilMs || untilMs <= Date.now()) return null;
    return { until: new Date(untilMs), detail: value?.detail || "model cooldown" };
  } catch {
    return null;
  }
}

async function markModelCooldown(platform: string, model: string, ms: number, detail: string) {
  try {
    const key = modelCooldownKey(platform, model);
    const until = new Date(Date.now() + ms).toISOString();
    await db
      .insert(mailKv)
      .values({
        namespace: MODEL_COOLDOWN_NS,
        key,
        value: { until, detail },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [mailKv.namespace, mailKv.key],
        set: { value: { until, detail }, updatedAt: new Date() },
      });
    appendRouterCooldownLog({
      kind: "model_cooldown",
      model: `${platform}/${model}`,
      detail: `model cooldown set for ${key}: ${detail}`,
      cooldownMs: ms,
    });
  } catch {
    /* best-effort: key cooldown still protects rotation */
  }
}

async function filterAvailableModels(candidates: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of candidates) {
    const parsed = splitModel(candidate);
    if (!parsed) continue;
    const cd = await getModelCooldown(parsed.platform, parsed.upstreamModel);
    if (cd) {
      // Proactively skipped — stay SILENT. Emitting a feed/vault event for every
      // already-cooled model on every request floods the rotation log and makes
      // it look like the router is still trying cooled models when it isn't.
      // Cooldowns are only surfaced when a model actually fails (in routeOne).
      continue;
    }
    out.push(candidate);
  }
  return out;
}

// ── token usage tracking ────────────────────────────────────────────────────
// Increment the per (key, model) tally. `todayTokens` resets when the UTC day
// rolls over (compared to the stored `today_date`). Best-effort: a failed write
// must never break the proxied response, so callers swallow errors.
async function recordUsage(
  keyId: string,
  platform: string,
  model: string,
  u: { prompt: number; completion: number; total: number },
) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  await db
    .insert(llmUsage)
    .values({
      keyId,
      platform,
      model,
      promptTokens: u.prompt,
      completionTokens: u.completion,
      totalTokens: u.total,
      requests: 1,
      todayTokens: u.total,
      todayDate: today,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [llmUsage.keyId, llmUsage.model],
      set: {
        promptTokens: sql`${llmUsage.promptTokens} + ${u.prompt}`,
        completionTokens: sql`${llmUsage.completionTokens} + ${u.completion}`,
        totalTokens: sql`${llmUsage.totalTokens} + ${u.total}`,
        requests: sql`${llmUsage.requests} + 1`,
        // Reset today's bucket when the day changed, else add to it.
        todayTokens: sql`CASE WHEN ${llmUsage.todayDate} = ${today} THEN ${llmUsage.todayTokens} + ${u.total} ELSE ${u.total} END`,
        todayDate: today,
        updatedAt: new Date(),
      },
    });
}

// Pull a usage object out of one parsed chat-completions payload (final JSON or
// a streamed chunk). Returns null when there's no usage block.
function usageFrom(obj: any): { prompt: number; completion: number; total: number } | null {
  const us = obj?.usage;
  if (!us) return null;
  const prompt = Number(us.prompt_tokens ?? us.promptTokens ?? 0) || 0;
  const completion = Number(us.completion_tokens ?? us.completionTokens ?? 0) || 0;
  const total = Number(us.total_tokens ?? us.totalTokens ?? prompt + completion) || 0;
  if (!total && !prompt && !completion) return null;
  return { prompt, completion, total };
}

// Read a CLONE of the upstream response (the original is streamed to the client
// untouched) and record token usage. Handles both a single JSON body and an SSE
// stream — for streams the usage block rides the final `data:` chunk (present
// when the caller passes stream_options.include_usage). Fully best-effort.
async function saveUsage(
  keyId: string,
  platform: string,
  model: string,
  usage: { prompt: number; completion: number; total: number },
) {
  pushRouterEvent({
    kind: "tokens",
    model: `${platform}/${model}`,
    key: keyId.slice(0, 8),
    prompt: usage.prompt,
    completion: usage.completion,
    total: usage.total,
  });
  await recordUsage(keyId, platform, model, usage);
}

async function captureUsage(clone: Response, keyId: string, platform: string, model: string) {
  try {
    const text = await clone.text();
    const ct = clone.headers.get("content-type") ?? "";
    let usage = null as ReturnType<typeof usageFrom>;
    if (ct.includes("text/event-stream") || text.startsWith("data:")) {
      // Scan SSE chunks back-to-front for the one carrying usage.
      const lines = text.split("\n").filter((l) => l.startsWith("data:"));
      for (let i = lines.length - 1; i >= 0; i--) {
        const payload = lines[i].slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const u = usageFrom(JSON.parse(payload));
          if (u) { usage = u; break; }
        } catch { /* skip non-JSON keepalive lines */ }
      }
    } else {
      usage = usageFrom(JSON.parse(text));
    }
    if (usage) {
      await saveUsage(keyId, platform, model, usage);
    }
  } catch (e) {
    // Usage accounting should not break a successful model response, but it
    // should leave a breadcrumb when the dashboard misses a served row.
    console.warn("[llm-router] usage capture failed:", e);
  }
}

async function responseWithUsageCapture(res: Response, keyId: string, platform: string, model: string): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream") || !res.body) {
    await captureUsage(res.clone(), keyId, platform, model);
    return res;
  }

  const decoder = new TextDecoder();
  let carry = "";
  let usage: ReturnType<typeof usageFrom> = null;
  const reader = res.body.getReader();

  function scan(text: string, flush = false) {
    carry += text;
    const lines = carry.split(/\r?\n/);
    carry = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = usageFrom(JSON.parse(payload));
        if (parsed) usage = parsed;
      } catch {
        // Ignore comments/keepalives/non-JSON provider chunks.
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          scan(decoder.decode(value, { stream: true }));
        }
        scan(decoder.decode(), true);
        controller.close();
        if (usage) await saveUsage(keyId, platform, model, usage);
      } catch (e) {
        console.warn("[llm-router] stream usage capture failed:", e);
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function buildHeaders(cfg: ProviderConfig, key: LlmKey): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (!cfg.keyless) h["Authorization"] = `Bearer ${key.apiKey}`;
  Object.assign(h, cfg.extraHeaders ?? {});
  return h;
}

export type RouteResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: string };

// "auto" rotation chain — the best free models, strongest-first. When a caller
// asks for model "auto" (e.g. Hermes), the router tries these in order, each
// with full per-key rotation, and fails over to the next on rate-limit /
// no-keys, so the model in use rotates as quotas come and go — the behaviour the
// old freellmapi "auto" gave. Candidates whose provider has no configured keys
// are skipped automatically (candidateKeys returns none). Ordered to match
// lib/model-rank.ts. Safe to expand as new free models appear.
export const FALLBACK_AUTO_CHAIN: string[] = [
  "groq/openai/gpt-oss-120b",
  "cerebras/gpt-oss-120b",
  "nvidia/meta-llama/llama-4-maverick-17b-128e-instruct",
  "groq/llama-3.3-70b-versatile",
  "groq/qwen/qwen3-32b",
  "google/gemini-2.5-flash",
  "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/openai/gpt-oss-20b",
  "google/gemini-2.5-flash-lite",
];

async function enabledPlatforms(): Promise<Set<string>> {
  const rows = await db
    .select({ platform: llmKeys.platform })
    .from(llmKeys)
    .where(eq(llmKeys.enabled, true));
  return new Set(rows.map((r) => r.platform));
}

async function disabledModelIds(): Promise<Set<string>> {
  const rows = await db
    .select({ platform: llmModels.platform, model: llmModels.model })
    .from(llmModels)
    .where(eq(llmModels.enabled, false));
  return new Set(rows.map((r) => `${r.platform}/${r.model}`));
}

async function fallbackAutoChain(): Promise<string[]> {
  const disabled = await disabledModelIds();
  return await filterAvailableModels(FALLBACK_AUTO_CHAIN.filter((id) => !disabled.has(id)));
}

async function autoChain(): Promise<string[]> {
  try {
    const platforms = await enabledPlatforms();
    if (!platforms.size) return await fallbackAutoChain();
    const rows = await db
      .select({ platform: llmModels.platform, model: llmModels.model })
      .from(llmModels)
      .where(eq(llmModels.enabled, true));
    const catalog = rows
      .filter((m) => platforms.has(m.platform) && PROVIDERS[m.platform])
      .map((m) => `${m.platform}/${m.model}`);
    const unique = [...new Set(catalog)].sort(byBestModel((m) => m));
    if (unique.length) return await filterAvailableModels(unique);
    return await fallbackAutoChain();
  } catch (e) {
    console.warn("[llm-router] model catalog unavailable; using fallback auto chain:", e);
    return await filterAvailableModels(FALLBACK_AUTO_CHAIN);
  }
}

// Per-model ceiling on completion tokens (`max_tokens` / `max_completion_tokens`).
// Some OpenAI-compatible clients — notably Hermes' "custom" provider, which can't
// know a model's limits — send a `max_tokens` equal to the full context window.
// Groq rejects that with a 400 ("`max_tokens` must be less than or equal to N …"),
// which the client then misreads as a context overflow and fails the whole turn.
// Clamping a too-large value to the model's real cap turns that hard failure into
// a normal completion. Keyed by "<platform>/<upstream-model>"; models not listed
// are left untouched (we only clamp where we know the true limit). Values are the
// providers' documented per-request completion maximums.
const MAX_COMPLETION_TOKENS: Record<string, number> = {
  "groq/openai/gpt-oss-120b": 65536,
  "groq/openai/gpt-oss-20b": 65536,
  "groq/llama-3.3-70b-versatile": 32768,
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": 8192,
  "groq/qwen/qwen3-32b": 40960,
};

// Return a shallow copy of `body` with `max_tokens` / `max_completion_tokens`
// clamped to the model's known cap. No-op when the model is unlisted or the
// requested value is already within the cap.
// On a STREAMING request, OpenAI-compatible providers omit the `usage` block
// unless the caller asks for it via `stream_options.include_usage`. Agent loops
// (Hermes, Pipeline) almost always stream, so without this their token spend is
// invisible — the live feed's served rows would sit forever at "waiting…". Inject
// the flag for streamed calls (no-op for non-stream, and left alone if the caller
// already set stream_options). Providers that don't recognise it generally ignore
// the extra field; if one rejects it, the router just fails over to the next key.
function withUsageOnStream(body: any): any {
  if (!body || body.stream !== true) return body;
  if (body.stream_options && typeof body.stream_options === "object") {
    if (body.stream_options.include_usage === undefined) {
      return { ...body, stream_options: { ...body.stream_options, include_usage: true } };
    }
    return body;
  }
  return { ...body, stream_options: { include_usage: true } };
}

function clampCompletionTokens(platform: string, upstreamModel: string, body: any): any {
  const cap = MAX_COMPLETION_TOKENS[`${platform}/${upstreamModel}`];
  if (!cap) return body;
  let clamped = body;
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const v = body?.[field];
    if (typeof v === "number" && v > cap) {
      if (clamped === body) clamped = { ...body };
      clamped[field] = cap;
      console.log(`[llm-router] clamped ${field} ${v} → ${cap} for ${platform}/${upstreamModel}`);
    }
  }
  return clamped;
}

/**
 * Route one chat-completions request. `body` is the parsed OpenAI request; its
 * `model` must be "<platform>/<model-id>", or "auto" to rotate across the best
 * free models. Streams pass through untouched.
 */
export async function routeChatCompletion(body: any): Promise<RouteResult> {
  const model = typeof body?.model === "string" ? body.model : "";

  // One shared routing config for the whole rotation. Each upstream call still
  // has a timeout, but the router walks every available key for a model before
  // moving to the next model.
  const cfg = await getRouterConfig();
  const budget = newBudget(
    cfg.timeoutMs,
    cfg.cooldownRateLimitMs,
    cfg.cooldownClientErrorMs,
  );

  // "auto" → rotate across the native model catalog. Each candidate gets exhaustive key
  // rotation; we fail over to the next model only after the current model has no
  // usable key left or the model itself is rejected by the provider.
  if (model === "auto" || model === "auto/auto") {
    let lastErr = "auto: no configured models were available (add keys in the LLM Keys tab).";
    let lastStatus = 503;
    for (const candidate of await autoChain()) {
      const parsed = splitModel(candidate);
      if (!parsed) continue;
      const res = await routeOne(parsed.platform, parsed.upstreamModel, body, budget);
      if (res.ok) {
        // A 4xx from the provider means this model rejected the request (e.g.
        // not served by these keys) — drop the response and try the next model.
        if (res.response.status >= 400) {
          void res.response.body?.cancel().catch(() => {});
          lastStatus = res.response.status;
          lastErr = `${res.response.status} from ${parsed.platform}/${parsed.upstreamModel}`;
          continue;
        }
        return res;
      }
      lastStatus = res.status;
      lastErr = res.error;
    }
    return { ok: false, status: lastStatus, error: lastErr };
  }

  const parsed = splitModel(model);
  if (!parsed) {
    return {
      ok: false,
      status: 400,
      error: `model must be "<platform>/<model>" (or "auto") with a known platform. Got "${model}". Platforms: ${listPlatforms().join(", ")}`,
    };
  }
  return routeOne(parsed.platform, parsed.upstreamModel, body, budget);
}

// Route one concrete model with exhaustive per-key LRU rotation + cooldown
// failover. It tries every currently usable key for this provider/model before
// the caller moves to the next model.
async function routeOne(
  platform: string,
  upstreamModel: string,
  body: any,
  budget: Budget,
): Promise<RouteResult> {
  const cfg = PROVIDERS[platform];
  const modelCooldown = await getModelCooldown(platform, upstreamModel);
  if (modelCooldown) {
    const fullModel = `${platform}/${upstreamModel}`;
    pushRouterEvent({
      kind: "cooldown",
      model: fullModel,
      detail: `model cooldown until ${modelCooldown.until.toLocaleTimeString("en-SG", { hour12: false })}`,
    });
    appendRouterCooldownLog({
      kind: "model_skip",
      model: fullModel,
      detail: `model cooldown skip: ${modelCooldown.detail}`,
      cooldownMs: Math.max(1, modelCooldown.until.getTime() - Date.now()),
    });
    return {
      ok: false,
      status: 503,
      error: `${platform}/${upstreamModel} is in model cooldown until ${modelCooldown.until.toISOString()}.`,
    };
  }

  const keys = await candidateKeys(platform);
  console.log(
    `[llm-router] ${platform}/${upstreamModel} — ${keys.length} key(s) available (LRU rotation)`
  );
  if (keys.length === 0) {
    pushRouterEvent({ kind: "nokeys", model: `${platform}/${upstreamModel}`, detail: "none enabled / all in cooldown" });
    return {
      ok: false,
      status: 503,
      error: `No available ${platform} keys (none enabled, or all in cooldown).`,
    };
  }

  const upstreamBody = JSON.stringify(
    withUsageOnStream({
      ...clampCompletionTokens(platform, upstreamModel, body),
      model: upstreamModel,
    }),
  );
  let lastErr = `All ${keys.length} ${platform} key(s) failed.`;

  for (const key of keys) {
    // A per-key baseUrl overrides the provider default — required for
    // 'custom' and 'cloudflare' (account-specific URL), optional elsewhere.
    const base = (key.baseUrl || cfg.baseUrl).replace(/\/$/, "");
    if (!base) {
      lastErr = `${platform} key ${key.id} has no baseUrl (set the account id / base url)`;
      continue;
    }
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(cfg, key),
        body: upstreamBody,
        // Hard ceiling (user-tunable) so a hung provider can't stall the turn.
        signal: AbortSignal.timeout(budget.timeoutMs),
      });
    } catch (e: any) {
      await markCooldown(key.id, COOLDOWN_MS.network);
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      lastErr = timedOut ? `timed out after ${Math.round(budget.timeoutMs / 1000)}s` : `network error: ${e?.message ?? e}`;
      await markModelCooldown(platform, upstreamModel, COOLDOWN_MS.network, lastErr);
      pushRouterEvent({ kind: "cooldown", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), detail: timedOut ? `timed out ${Math.round(budget.timeoutMs / 1000)}s` : "network error" });
      appendRouterCooldownLog({
        kind: "network",
        model: `${platform}/${upstreamModel}`,
        key: key.id.slice(0, 8),
        detail: lastErr,
        cooldownMs: COOLDOWN_MS.network,
      });
      return { ok: false, status: 503, error: lastErr };
    }

    if (res.ok) {
      console.log(`[llm-router] ✓ ${platform}/${upstreamModel} via key ${key.id.slice(0, 8)}`);
      pushRouterEvent({ kind: "served", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), status: res.status });
      await markUsed(key.id);
      return {
        ok: true,
        response: await responseWithUsageCapture(res, key.id, platform, upstreamModel),
      };
    }

    // 429 / 5xx → this key is throttled or the upstream is down: cool it down
    // and try the next key. Other 4xx (bad request, unknown model) are the
    // caller's fault — return immediately rather than burning every key.
    if (res.status === 429) {
      console.log(`[llm-router] ⏭ key ${key.id.slice(0, 8)} 429 (cooldown) — next key`);
      await markCooldown(key.id, budget.cdRateLimit);
      await markModelCooldown(platform, upstreamModel, budget.cdRateLimit, "429 rate limit");
      pushRouterEvent({ kind: "cooldown", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), status: 429, detail: "429 rate limit" });
      appendRouterCooldownLog({
        kind: "rate_limit",
        model: `${platform}/${upstreamModel}`,
        key: key.id.slice(0, 8),
        status: 429,
        detail: "429 rate limit",
        cooldownMs: budget.cdRateLimit,
      });
      lastErr = `429 from ${platform}`;
      return { ok: false, status: 429, error: lastErr };
    }
    if (res.status >= 500) {
      console.log(`[llm-router] ⏭ key ${key.id.slice(0, 8)} ${res.status} — next key`);
      await markCooldown(key.id, COOLDOWN_MS.serverError);
      await markModelCooldown(platform, upstreamModel, COOLDOWN_MS.serverError, `${res.status} server error`);
      pushRouterEvent({ kind: "cooldown", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), status: res.status, detail: `${res.status} server error` });
      appendRouterCooldownLog({
        kind: "server_error",
        model: `${platform}/${upstreamModel}`,
        key: key.id.slice(0, 8),
        status: res.status,
        detail: `${res.status} server error`,
        cooldownMs: COOLDOWN_MS.serverError,
      });
      lastErr = `${res.status} from ${platform}`;
      return { ok: false, status: res.status, error: lastErr };
    }
    // 413 "Request too large" is, on free tiers, a tokens-per-minute rate limit
    // (Groq returns it with code "rate_limit_exceeded" / type "tokens" when
    // prompt + max_tokens exceeds the per-minute budget), not a fixable client
    // error. Treat it like a 429: cool the key down and fail over to the next
    // key / auto-model (e.g. Gemini, with far higher limits) instead of dying.
    // A genuine "payload too large" still cools down and rotates — harmless,
    // since the next candidate is a different model/tier.
    if (res.status === 413) {
      const detail = await res.text().catch(() => "");
      console.log(`[llm-router] ⏭ key ${key.id.slice(0, 8)} 413 (too large / TPM) — next key`);
      await markCooldown(key.id, budget.cdRateLimit);
      await markModelCooldown(platform, upstreamModel, budget.cdRateLimit, "413 too large / TPM");
      pushRouterEvent({ kind: "cooldown", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), status: 413, detail: "413 too large / TPM" });
      appendRouterCooldownLog({
        kind: "rate_limit",
        model: `${platform}/${upstreamModel}`,
        key: key.id.slice(0, 8),
        status: 413,
        detail: "413 too large / TPM",
        cooldownMs: budget.cdRateLimit,
      });
      lastErr = `413 from ${platform}/${upstreamModel}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
      return { ok: false, status: 413, error: lastErr };
    }
    // Non-retryable client error (400/401/404 …) — the model is rejecting
    // requests, so cool the key down (default 1 day, tunable) instead of leaving
    // it warm and getting it re-picked every turn. Still surface the upstream
    // response verbatim so the caller sees the real error.
    pushRouterEvent({ kind: "client_error", model: `${platform}/${upstreamModel}`, key: key.id.slice(0, 8), status: res.status, detail: `${res.status} client error` });
    await markCooldown(key.id, budget.cdClientError);
    await markModelCooldown(platform, upstreamModel, budget.cdClientError, `${res.status} client error`);
    appendRouterCooldownLog({
      kind: "client_error",
      model: `${platform}/${upstreamModel}`,
      key: key.id.slice(0, 8),
      status: res.status,
      detail: `${res.status} client error`,
      cooldownMs: budget.cdClientError,
    });
    return { ok: true, response: res };
  }

  return { ok: false, status: 503, error: lastErr };
}
