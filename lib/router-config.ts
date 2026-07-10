// Runtime-tunable knobs for the rotating router (lib/llm-router.ts): per-call
// timeout and cooldown durations. Stored in mail_kv (namespace "router", key
// "config") so the value survives serverless invocations and both the
// in-process voice path and the /api/v1 proxy read the same setting. Same
// pattern as lib/model-config.ts.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { ttlCache } from "./ttl-cache";

const NS = "router";
const KEY = "config";

export type RouterConfig = {
  // Hard per-call timeout in ms.
  timeoutMs: number;
  // How long a key sits out after a 429 / 413 (rate limit) before the router
  // tries it again. Default 30 min — long enough that a throttled provider
  // isn't re-picked every turn and wasting time.
  cooldownRateLimitMs: number;
  // How long a key sits out after a non-retryable 4xx client error (400/401/
  // 404 …). Default 1 day — a model that's rejecting requests shouldn't keep
  // getting rotated to.
  cooldownClientErrorMs: number;
  // Max keys the router tries for ONE model on a single call before giving up on
  // it (and the caller fails over to the next model). 0 = walk EVERY available
  // key (the original behaviour). A small cap makes a dead/throttled provider
  // fail over faster instead of burning through all its keys.
  maxKeysPerModel: number;
};

export const ROUTER_DEFAULTS: RouterConfig = {
  // Hard per-call ceiling. Kept well UNDER the serverless function budget
  // (voice/page run with maxDuration 60s) so one slow/hanging upstream can't
  // eat the whole request and trigger a 504 before any fallback is tried.
  timeoutMs: 8_000,
  cooldownRateLimitMs: 30 * 60_000, // 30 min
  cooldownClientErrorMs: 24 * 60 * 60_000, // 1 day
  // Don't burn the entire request walking every key of a dead/throttled
  // provider — fail over to the next model after a few tries.
  maxKeysPerModel: 2,
};

// Bounds keep the UI sliders sane and stop a bad value from hanging requests.
export const ROUTER_LIMITS = {
  timeoutMs: { min: 5_000, max: 120_000 },
  cooldownRateLimitMs: { min: 60_000, max: 6 * 60 * 60_000 }, // 1 min … 6 h
  cooldownClientErrorMs: { min: 60_000, max: 7 * 24 * 60 * 60_000 }, // 1 min … 7 d
  maxKeysPerModel: { min: 0, max: 20 }, // 0 = unlimited
};

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalize(v: Partial<RouterConfig> | null): RouterConfig {
  return {
    timeoutMs: clamp(
      Number(v?.timeoutMs),
      ROUTER_LIMITS.timeoutMs.min,
      ROUTER_LIMITS.timeoutMs.max,
      ROUTER_DEFAULTS.timeoutMs,
    ),
    cooldownRateLimitMs: clamp(
      Number(v?.cooldownRateLimitMs),
      ROUTER_LIMITS.cooldownRateLimitMs.min,
      ROUTER_LIMITS.cooldownRateLimitMs.max,
      ROUTER_DEFAULTS.cooldownRateLimitMs,
    ),
    cooldownClientErrorMs: clamp(
      Number(v?.cooldownClientErrorMs),
      ROUTER_LIMITS.cooldownClientErrorMs.min,
      ROUTER_LIMITS.cooldownClientErrorMs.max,
      ROUTER_DEFAULTS.cooldownClientErrorMs,
    ),
    maxKeysPerModel: clamp(
      Number(v?.maxKeysPerModel),
      ROUTER_LIMITS.maxKeysPerModel.min,
      ROUTER_LIMITS.maxKeysPerModel.max,
      ROUTER_DEFAULTS.maxKeysPerModel,
    ),
  };
}

// Short per-instance cache: the config changes only when the user moves a slider
// (saveRouterConfig busts it), so a few seconds of staleness saves a Neon hop on
// every routed turn.
const configCache = ttlCache(async (): Promise<RouterConfig> => {
  try {
    const rows = await db
      .select({ value: mailKv.value })
      .from(mailKv)
      .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
    return normalize(rows.length ? (rows[0].value as Partial<RouterConfig>) : null);
  } catch {
    // Never let a config read break routing — fall back to defaults.
    return { ...ROUTER_DEFAULTS };
  }
}, 30_000);

export async function getRouterConfig(): Promise<RouterConfig> {
  return configCache.get();
}

export async function saveRouterConfig(input: Partial<RouterConfig>): Promise<RouterConfig> {
  // Merge over the current config so a partial update (e.g. just the timeout
  // slider) never resets the other knobs back to their defaults. Only keys with
  // a defined value override current — undefined fields (omitted by the caller)
  // must not blow away an existing value.
  const current = await getRouterConfig();
  const defined: Partial<RouterConfig> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (defined as Record<string, unknown>)[k] = v;
  }
  const cfg = normalize({ ...current, ...defined });
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: cfg as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: cfg as object, updatedAt: new Date() },
    });
  configCache.bust();
  return cfg;
}
