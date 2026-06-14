// Live router event feed — the "what model just got used, on which key, for how
// many tokens" stream that the old FreeLLMAPI dashboard showed. The rotating
// proxy (lib/llm-router.ts) is the single chokepoint EVERY model call goes
// through (voice, Pipeline, and Hermes — Hermes points its provider at our
// /api/v1), so emitting one event per upstream decision here gives a complete
// live rotation + token trace.
//
// This is a process-local in-memory ring buffer (no DB, no cost). It's read by
// polling GET /api/router-feed?since=<lastId>, which the RouterFeed panel hits
// every second. Token counts arrive a beat after the "served" line (usage is
// parsed from a response clone), so they're emitted as their own follow-up
// event keyed by the same model+key — the panel stitches them onto the row.
//
// Single-process only (fine for local dev + a single serverless instance); on a
// multi-instance deploy each instance keeps its own recent feed, which is
// acceptable for a live debug view.

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

const MAX = 200;

// Pin the buffer on globalThis. In Next.js the /api/v1 (writer) and
// /api/router-feed (reader) route handlers can be compiled into SEPARATE server
// bundles, each with its own copy of a module-level `const buf = []` — so events
// pushed by the proxy would land in a different array than the feed reads, and
// the panel would stay empty forever. A globalThis-backed store is shared across
// every bundle in the process, so writer and reader see the same ring buffer.
type FeedStore = { buf: RouterEvent[]; seq: number };
const g = globalThis as unknown as { __routerFeed?: FeedStore };
const store: FeedStore = (g.__routerFeed ??= { buf: [], seq: 1 });

// Append one event; returns the assigned id. Never throws — feed bookkeeping
// must not break a proxied request.
export function pushRouterEvent(e: Omit<RouterEvent, "id" | "at">): number {
  const id = store.seq++;
  store.buf.push({ ...e, id, at: Date.now() });
  if (store.buf.length > MAX) store.buf.splice(0, store.buf.length - MAX);
  // One concise line so the data path is visible in `npm run dev` even before the
  // UI panel is open. e.g. "[router-feed] served groq/openai/gpt-oss-120b key 3f12abcd".
  const tail = e.total != null ? `${e.total} tok` : e.detail ?? "";
  console.log(`[router-feed] ${e.kind} ${e.model}${e.key ? ` key ${e.key}` : ""}${tail ? ` — ${tail}` : ""}`);
  return id;
}

// Events newer than `since` (exclusive), plus the current high-water id so the
// poller can advance even when nothing new arrived. `since <= 0` returns the
// whole buffer (a fresh panel's first load).
export function getRouterEvents(since = 0): { events: RouterEvent[]; lastId: number } {
  const events = since > 0 ? store.buf.filter((e) => e.id > since) : store.buf.slice();
  return { events, lastId: store.seq - 1 };
}

export function clearRouterEvents(): { lastId: number } {
  store.buf.length = 0;
  return { lastId: store.seq - 1 };
}
