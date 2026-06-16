// Live router event feed — the "what model just got used, on which key, for how
// many tokens" stream that the old FreeLLMAPI dashboard showed. The rotating
// proxy (lib/llm-router.ts) is the single chokepoint EVERY model call goes
// through (voice, Pipeline, and Hermes — Hermes points its provider at our
// /api/v1), so emitting one event per upstream decision here gives a complete
// live rotation + token trace.
//
// Storage is Postgres (table `router_events`). This MUST be durable across
// instances: on a serverless deploy the /api/v1 (writer) and /api/router-feed
// (reader) handlers run in DIFFERENT instances, so a process-local in-memory
// buffer the writer fills is invisible to the reader and the panel stays empty
// forever — exactly the "live rotation doesn't log on cloud" bug. Writing each
// event to the shared DB fixes that; the reader polls GET /api/router-feed?since.
//
// To keep the request hot-path fast, pushes are fire-and-forget (we never await
// the insert inside a proxied call) and ALSO mirrored into a small process-local
// ring so same-instance/local reads are instant even before the insert lands.
// Token counts arrive a beat after the "served" line (usage is parsed from a
// response clone), so they're emitted as their own follow-up event keyed by the
// same model+key — the panel stitches them onto the row.

import { desc, gt, lt, sql } from "drizzle-orm";
import { db, routerEvents } from "@/db";

export type RouterEventKind =
  | "served" // an upstream call returned 2xx on this model+key
  | "tokens" // usage parsed for a just-served call (prompt/completion/total)
  | "cooldown" // a key was rate-limited / errored and put in cooldown
  | "nokeys" // no usable keys for the requested provider
  | "client_error"; // a non-retryable 4xx surfaced to the caller

export type RouterEvent = {
  id: number;
  at: number; // ms epoch
  kind: RouterEventKind;
  model: string; // "<platform>/<upstream-model>"
  key?: string; // short key id (first 8 chars)
  status?: number; // upstream HTTP status, when relevant
  prompt?: number;
  completion?: number;
  total?: number;
  detail?: string; // short human note ("429 rate limit", "timed out 30s", …)
};

// Keep only the recent tail in the table so the append-only log can't grow
// without bound; pruned opportunistically (see maybePrune).
const KEEP_ROWS = 400;
const PRUNE_EVERY = 50;

// Small process-local mirror so a reader hitting the SAME instance sees an event
// instantly (and local dev still works if the DB write is briefly behind). The
// DB is the source of truth across instances; this is just a latency shim.
type FeedStore = { recent: RouterEvent[]; sincePrune: number };
const g = globalThis as unknown as { __routerFeed?: FeedStore };
const store: FeedStore = (g.__routerFeed ??= { recent: [], sincePrune: 0 });

function mapRow(r: typeof routerEvents.$inferSelect): RouterEvent {
  return {
    id: r.id,
    at: Number(r.at),
    kind: r.kind as RouterEventKind,
    model: r.model,
    key: r.apiKey ?? undefined,
    status: r.status ?? undefined,
    prompt: r.prompt ?? undefined,
    completion: r.completion ?? undefined,
    total: r.total ?? undefined,
    detail: r.detail ?? undefined,
  };
}

async function maybePrune() {
  if (++store.sincePrune < PRUNE_EVERY) return;
  store.sincePrune = 0;
  try {
    // Delete everything older than the newest KEEP_ROWS rows.
    const cutoff = await db
      .select({ id: routerEvents.id })
      .from(routerEvents)
      .orderBy(desc(routerEvents.id))
      .limit(1)
      .offset(KEEP_ROWS);
    if (cutoff.length) await db.delete(routerEvents).where(lt(routerEvents.id, cutoff[0].id));
  } catch {
    /* best-effort */
  }
}

// Append one event. Fire-and-forget: the DB insert is NOT awaited so it never
// adds latency to (or can fail) a proxied request. Never throws.
export function pushRouterEvent(e: Omit<RouterEvent, "id" | "at">): void {
  const at = Date.now();
  // One concise line so the data path is visible in `npm run dev` even before the
  // UI panel is open. e.g. "[router-feed] served groq/openai/gpt-oss-120b key 3f12abcd".
  const tail = e.total != null ? `${e.total} tok` : e.detail ?? "";
  console.log(`[router-feed] ${e.kind} ${e.model}${e.key ? ` key ${e.key}` : ""}${tail ? ` — ${tail}` : ""}`);
  void persist(e, at);
}

async function persist(e: Omit<RouterEvent, "id" | "at">, at: number) {
  try {
    const [row] = await db
      .insert(routerEvents)
      .values({
        at,
        kind: e.kind,
        model: e.model,
        apiKey: e.key ?? null,
        status: e.status ?? null,
        prompt: e.prompt ?? null,
        completion: e.completion ?? null,
        total: e.total ?? null,
        detail: e.detail ?? null,
      })
      .returning();
    if (row) {
      store.recent.push(mapRow(row));
      if (store.recent.length > KEEP_ROWS) store.recent.splice(0, store.recent.length - KEEP_ROWS);
    }
    await maybePrune();
  } catch {
    /* best-effort — a feed write must never break a proxied request */
  }
}

// Events newer than `since` (exclusive), plus the current high-water id so the
// poller can advance even when nothing new arrived. Reads the shared DB so the
// feed is correct across serverless instances; falls back to the in-memory
// mirror if the DB read fails.
export async function getRouterEvents(since = 0): Promise<{ events: RouterEvent[]; lastId: number }> {
  try {
    const rows = since > 0
      ? await db.select().from(routerEvents).where(gt(routerEvents.id, since)).orderBy(routerEvents.id)
      : await db.select().from(routerEvents).orderBy(desc(routerEvents.id)).limit(KEEP_ROWS);
    const events = (since > 0 ? rows : rows.slice().reverse()).map(mapRow);
    const maxRow = await db.select({ max: sql<number>`max(${routerEvents.id})` }).from(routerEvents);
    const lastId = Number(maxRow[0]?.max ?? 0) || events[events.length - 1]?.id || since;
    return { events, lastId };
  } catch {
    const events = since > 0 ? store.recent.filter((e) => e.id > since) : store.recent.slice();
    const lastId = store.recent.length ? store.recent[store.recent.length - 1].id : since;
    return { events, lastId };
  }
}

export async function clearRouterEvents(): Promise<{ lastId: number }> {
  store.recent.length = 0;
  try {
    const maxRow = await db.select({ max: sql<number>`max(${routerEvents.id})` }).from(routerEvents);
    const lastId = Number(maxRow[0]?.max ?? 0);
    await db.delete(routerEvents);
    return { lastId };
  } catch {
    return { lastId: 0 };
  }
}
