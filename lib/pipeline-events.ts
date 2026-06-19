// Progress event channel for cloud-triggered pipeline runs.
//
// When the phone starts a pipeline phase, the loop runs on the LAPTOP bridge
// (it owns the filesystem + shell). The bridge can't be reached inbound, so it
// PUSHES progress events here (POST /api/pipeline/events) and the phone PULLS
// them (GET, since-cursor). Backed by mail_kv (namespace "pipeline_events", one
// row per project) to avoid a migration — single user, low volume.
//
// This is deliberately separate from the bridge_relay command queue: a phase is
// a long, multi-round run (minutes), far longer than the relay's 90s stale
// window, so it can't ride the normal claim→dispatch→result flow without being
// re-queued and double-run. The bridge acks the start command immediately and
// reports real progress through this stream instead.
import "server-only";
import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "pipeline_events";
// Keep the last N events per project — enough for the phone to catch up after a
// reconnect without the row growing without bound.
const MAX_EVENTS = 400;

// One progress event, shaped like lib/pipeline-agent.ts's PipelineEvent plus a
// monotonic cursor `i` and a server timestamp `ts`. `running` flips false on a
// terminal phase event (done/error/stopped/capped) so the phone stops polling.
export type StoredPipelineEvent = {
  i: number;
  ts: number;
  phase: string; // thinking | tool | result | review | done | error | info
  team?: string;
  summary: string;
  detail?: string;
  tool?: string;
  status?: string;
  round?: number;
  model?: string;
};

type EventDoc = {
  seq: number; // next cursor to assign
  running: boolean; // false once a terminal event lands
  updatedAt: number;
  events: StoredPipelineEvent[];
};

const EMPTY: EventDoc = { seq: 0, running: false, updatedAt: 0, events: [] };

async function read(projectId: string): Promise<EventDoc> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, projectId)))
    .limit(1);
  const v = rows[0]?.value as EventDoc | undefined;
  if (!v || !Array.isArray(v.events)) return { ...EMPTY };
  return v;
}

async function write(projectId: string, doc: EventDoc) {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: projectId, value: doc as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: doc as object, updatedAt: new Date() },
    });
}

const TERMINAL = new Set(["done", "error", "stopped", "capped"]);

// Append a batch of progress events for a project, assigning each a monotonic
// cursor. `started` (the very first append of a run) resets the stream so a
// re-run doesn't show the previous run's tail.
export async function appendEvents(
  projectId: string,
  incoming: Omit<StoredPipelineEvent, "i" | "ts">[],
  opts: { started?: boolean } = {}
): Promise<{ cursor: number }> {
  const doc = opts.started ? { ...EMPTY } : await read(projectId);
  const now = Date.now();
  if (opts.started) doc.running = true;
  for (const e of incoming) {
    doc.events.push({ ...e, i: doc.seq++, ts: now });
    if (TERMINAL.has(e.phase)) doc.running = false;
  }
  if (doc.events.length > MAX_EVENTS) doc.events = doc.events.slice(-MAX_EVENTS);
  doc.updatedAt = now;
  await write(projectId, doc);
  return { cursor: doc.seq };
}

// Events with cursor > since, plus whether the run is still going. The phone
// long-polls this and stops when running is false and it has drained the tail.
export async function readEvents(
  projectId: string,
  since: number
): Promise<{ events: StoredPipelineEvent[]; cursor: number; running: boolean }> {
  const doc = await read(projectId);
  return {
    events: doc.events.filter((e) => e.i > since),
    cursor: doc.seq,
    running: doc.running,
  };
}
