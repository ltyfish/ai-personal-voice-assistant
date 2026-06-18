// Server-side store for the phone⇄cloud⇄laptop relay.
//
// The laptop bridge can't be reached inbound (NAT/firewall) and Vercel can't
// reach it either, so the bridge connects OUTBOUND to these endpoints: it
// heartbeats presence and polls a tiny command queue. The phone (cloud web app)
// enqueues commands and polls for their result. Everything is gated by a single
// shared RELAY_SECRET — with full-shell access enabled, that secret is a remote
// key to the machine, so it must be long/random and is never logged.
//
// Backed by mail_kv (namespace "bridge_relay") to avoid a migration. Single
// user, low volume, so a JSON queue is fine.
import "server-only";
import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "bridge_relay";
const PRESENCE_KEY = "presence";
const QUEUE_KEY = "queue";

// A command is considered in-flight at most this long before it's re-queued
// (the bridge died mid-run). Done commands are pruned after this too.
const STALE_MS = 90_000;
const MAX_QUEUE = 50;

export type Presence = {
  lastSeen: number; // epoch ms of the last heartbeat
  home?: string;
  apps?: string[];
  shellEnabled?: boolean;
};

// The body mirrors the bridge's existing /run payload, so the bridge can
// dispatch it through the SAME internal handlers (openApp / runShell / page_*).
export type RelayCommand = {
  id: string;
  body: Record<string, unknown>;
  status: "queued" | "running" | "done";
  result?: { ok: boolean; status: number; data: unknown };
  createdAt: number;
  updatedAt: number;
};

async function kvGet<T>(key: string): Promise<T | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, key)));
  return rows.length ? (rows[0].value as T) : null;
}

async function kvSet(key: string, value: unknown) {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key, value: value as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: value as object, updatedAt: new Date() },
    });
}

// ── auth ────────────────────────────────────────────────────────────────────
// True when the request carries the shared relay secret. Returns false (never
// throws) if no secret is configured server-side, so the relay is simply off
// until RELAY_SECRET is set.
export function relayAuthorized(req: Request): boolean {
  const secret = process.env.RELAY_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && token === secret;
}

// ── presence ──────────────────────────────────────────────────────────────--
export async function setPresence(p: Presence) {
  await kvSet(PRESENCE_KEY, { ...p, lastSeen: Date.now() });
}

export async function getPresence(): Promise<Presence | null> {
  return kvGet<Presence>(PRESENCE_KEY);
}

// ── command queue ───────────────────────────────────────────────────────────
async function getQueue(): Promise<RelayCommand[]> {
  return (await kvGet<RelayCommand[]>(QUEUE_KEY)) ?? [];
}

async function saveQueue(q: RelayCommand[]) {
  await kvSet(QUEUE_KEY, q);
}

// Drop done/stale commands so the queue can't grow without bound, and re-queue
// any command that's been "running" too long (the bridge crashed mid-run).
function tidy(q: RelayCommand[]): RelayCommand[] {
  const now = Date.now();
  for (const c of q) {
    if (c.status === "running" && now - c.updatedAt > STALE_MS) {
      c.status = "queued";
      c.updatedAt = now;
    }
  }
  return q
    .filter((c) => !(c.status === "done" && now - c.updatedAt > STALE_MS))
    .slice(-MAX_QUEUE);
}

export async function enqueue(body: Record<string, unknown>): Promise<string> {
  const q = tidy(await getQueue());
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  q.push({ id, body, status: "queued", createdAt: now, updatedAt: now });
  await saveQueue(q);
  return id;
}

// Bridge claims the oldest queued command (marks it running) and runs it.
export async function claimNext(): Promise<RelayCommand | null> {
  const q = tidy(await getQueue());
  const cmd = q.find((c) => c.status === "queued");
  if (cmd) {
    cmd.status = "running";
    cmd.updatedAt = Date.now();
  }
  await saveQueue(q);
  return cmd ?? null;
}

export async function completeCommand(
  id: string,
  result: RelayCommand["result"]
): Promise<boolean> {
  const q = await getQueue();
  const cmd = q.find((c) => c.id === id);
  if (!cmd) return false;
  cmd.status = "done";
  cmd.result = result;
  cmd.updatedAt = Date.now();
  await saveQueue(q);
  return true;
}

export async function getCommand(id: string): Promise<RelayCommand | null> {
  const q = await getQueue();
  return q.find((c) => c.id === id) ?? null;
}
