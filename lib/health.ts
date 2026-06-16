// Project health checks (server-side, bridge-free → works deployed AND locally).
//
// Two kinds of health:
//   1. This app's own self-health — getSelfHealth() (db reachable? required env
//      present?). Exposed at /api/health for any uptime monitor or for JARVIS.
//   2. User-configured URL pings — a list of endpoints to GET/HEAD; runCheck()
//      reports up/down + HTTP status + latency. Config + last results live in the
//      existing mail_kv table (namespace "health"), so no migration is needed.
//
// SSRF note: the checks ping arbitrary URLs the (single) user configures on their
// own deployment. That's acceptable for a self-hosted personal tool; we still
// constrain to http/https, cap the timeout, and never read the response body.

import { and, eq, sql } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { randomUUID } from "node:crypto";

const NS = "health";
const PING_TIMEOUT_MS = 10_000;

export type HealthCheck = {
  id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  expectStatus?: number; // optional exact status to require (else any 2xx/3xx = up)
};

export type CheckResult = {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
  checkedAt: string;
};

// ── config (mail_kv) ─────────────────────────────────────────────────────────
async function kvGet<T>(key: string): Promise<T | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, key)));
  return rows.length ? (rows[0].value as T) : null;
}

async function kvSet(key: string, value: object): Promise<void> {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key, value })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value, updatedAt: new Date() },
    });
}

export function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function listChecks(): Promise<HealthCheck[]> {
  const v = await kvGet<{ checks?: HealthCheck[] }>("checks");
  return Array.isArray(v?.checks) ? v!.checks : [];
}

export async function addCheck(input: { name: string; url: string; method?: string; expectStatus?: number }): Promise<HealthCheck[]> {
  const url = (input.url || "").trim();
  if (!isValidUrl(url)) throw new Error("URL must be a valid http(s) address.");
  const check: HealthCheck = {
    id: randomUUID(),
    name: (input.name || url).trim().slice(0, 80),
    url,
    method: input.method === "HEAD" ? "HEAD" : "GET",
    expectStatus: Number.isInteger(input.expectStatus) ? input.expectStatus : undefined,
  };
  const checks = await listChecks();
  checks.push(check);
  await kvSet("checks", { checks });
  return checks;
}

export async function removeCheck(id: string): Promise<HealthCheck[]> {
  const checks = (await listChecks()).filter((c) => c.id !== id);
  await kvSet("checks", { checks });
  return checks;
}

export async function getLastResults(): Promise<CheckResult[]> {
  const v = await kvGet<{ results?: CheckResult[] }>("results");
  return Array.isArray(v?.results) ? v!.results : [];
}

// ── running checks ───────────────────────────────────────────────────────────
export async function runCheck(c: HealthCheck): Promise<CheckResult> {
  const base: CheckResult = { id: c.id, name: c.name, url: c.url, ok: false, status: null, latencyMs: null, checkedAt: new Date().toISOString() };
  if (!isValidUrl(c.url)) return { ...base, error: "invalid url" };
  const t0 = Date.now();
  try {
    const res = await fetch(c.url, {
      method: c.method === "HEAD" ? "HEAD" : "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const ok = c.expectStatus ? res.status === c.expectStatus : res.status >= 200 && res.status < 400;
    // Drain/limit the body so the connection closes cleanly; we never use it.
    res.body?.cancel().catch(() => {});
    return { ...base, ok, status: res.status, latencyMs };
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ...base, latencyMs: Date.now() - t0, error: timedOut ? "timed out" : e?.message || "request failed" };
  }
}

export async function runAll(): Promise<CheckResult[]> {
  const checks = await listChecks();
  const results = await Promise.all(checks.map(runCheck));
  await kvSet("results", { results, ranAt: new Date().toISOString() });
  return results;
}

export async function runOne(id: string): Promise<CheckResult | null> {
  const c = (await listChecks()).find((x) => x.id === id);
  if (!c) return null;
  const result = await runCheck(c);
  // Merge into the cached results so the dashboard stays consistent.
  const prev = (await getLastResults()).filter((r) => r.id !== id);
  await kvSet("results", { results: [...prev, result], ranAt: new Date().toISOString() });
  return result;
}

// ── this app's own health (the /api/health payload) ──────────────────────────
export type SelfHealth = {
  ok: boolean;
  time: string;
  db: boolean;
  env: { name: string; present: boolean }[];
};

const REQUIRED_ENV = ["DATABASE_URL"];
const OPTIONAL_ENV = ["GEMINI_API_KEY", "GITHUB_TOKEN", "DASHBOARD_SECRET"];

export async function getSelfHealth(): Promise<SelfHealth> {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const env = [...REQUIRED_ENV, ...OPTIONAL_ENV].map((name) => ({ name, present: !!process.env[name] }));
  const requiredOk = REQUIRED_ENV.every((n) => !!process.env[n]);
  return { ok: dbOk && requiredOk, time: new Date().toISOString(), db: dbOk, env };
}
