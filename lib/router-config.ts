// Runtime-tunable knobs for the rotating router (lib/llm-router.ts): per-call
// timeout and cooldown durations. Stored in mail_kv (namespace "router", key
// "config") so the value survives serverless invocations and both the
// in-process voice path and the /api/v1 proxy read the same setting. Same
// pattern as lib/model-config.ts.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

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
};

export const ROUTER_DEFAULTS: RouterConfig = {
  timeoutMs: 30_000,
  cooldownRateLimitMs: 30 * 60_000, // 30 min
  cooldownClientErrorMs: 24 * 60 * 60_000, // 1 day
};

// Bounds keep the UI sliders sane and stop a bad value from hanging requests.
export const ROUTER_LIMITS = {
  timeoutMs: { min: 5_000, max: 120_000 },
  cooldownRateLimitMs: { min: 60_000, max: 6 * 60 * 60_000 }, // 1 min … 6 h
  cooldownClientErrorMs: { min: 60_000, max: 7 * 24 * 60 * 60_000 }, // 1 min … 7 d
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
  };
}

export async function getRouterConfig(): Promise<RouterConfig> {
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
}

export async function saveRouterConfig(input: Partial<RouterConfig>): Promise<RouterConfig> {
  const cfg = normalize(input);
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: cfg as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: cfg as object, updatedAt: new Date() },
    });
  return cfg;
}
