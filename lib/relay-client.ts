"use client";

// Browser-side client for the cloud relay — the path that lets your PHONE drive
// the laptop. On a desktop the browser talks to the bridge directly over
// localhost (lib/bridge.ts); on the phone localhost is the phone itself, so
// action payloads are instead enqueued to the cloud (/api/bridge/*), which the
// laptop bridge drains. Same payload shape as the bridge's /run, so the bridge
// runs it through the identical safety gates.

const SECRET_KEY = "relay.secret";

// The relay secret is entered once on the phone (Bridge settings). It must match
// RELAY_SECRET in the Vercel env and the bridge's env.
export function getRelaySecret(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SECRET_KEY) || "";
}

export function setRelaySecret(s: string) {
  localStorage.setItem(SECRET_KEY, s.trim());
}

export function relayConfigured(): boolean {
  return !!getRelaySecret();
}

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${getRelaySecret()}`, ...extra };
}

export type RelayPresence = {
  online: boolean;
  home: string;
  apps: string[];
  shellEnabled: boolean;
};

const PRESENCE_OFFLINE: RelayPresence = { online: false, home: "", apps: [], shellEnabled: false };

// Is the laptop reporting in to the cloud? Used so the phone shows the Local
// features and routes turns through the relay. Never throws.
export async function fetchRelayPresence(): Promise<RelayPresence> {
  if (!relayConfigured()) return PRESENCE_OFFLINE;
  try {
    const res = await fetch("/api/bridge/presence", { headers: authHeaders() });
    if (!res.ok) return PRESENCE_OFFLINE;
    const d = await res.json();
    return {
      online: !!d.online,
      home: d.home || "",
      apps: Array.isArray(d.apps) ? d.apps : [],
      shellEnabled: !!d.shellEnabled,
    };
  } catch {
    return PRESENCE_OFFLINE;
  }
}

// ── pipeline progress stream ─────────────────────────────────────────────────
// A cloud-triggered pipeline phase runs on the laptop bridge and pushes progress
// to /api/pipeline/events; the UI pulls it here (since-cursor). Same relay-secret
// gate as the rest of the relay. Returns an empty, not-running result on any error
// so the poller can simply stop.
export type PipelineEventBatch = {
  events: Array<{
    i: number; ts: number; phase: string; team?: string; summary: string;
    detail?: string; tool?: string; status?: string; round?: number; model?: string;
  }>;
  cursor: number;
  running: boolean;
};

export async function fetchPipelineEvents(id: string, since: number): Promise<PipelineEventBatch> {
  const empty: PipelineEventBatch = { events: [], cursor: since, running: false };
  if (!relayConfigured() || !id) return empty;
  try {
    const res = await fetch(
      `/api/pipeline/events?id=${encodeURIComponent(id)}&since=${since}`,
      { headers: authHeaders() }
    );
    if (!res.ok) return empty;
    const d = await res.json();
    return {
      events: Array.isArray(d.events) ? d.events : [],
      cursor: typeof d.cursor === "number" ? d.cursor : since,
      running: !!d.running,
    };
  } catch {
    return empty;
  }
}

export type RelayRunResult = { httpOk: boolean; status: number; data: any };

// Enqueue an action for the laptop bridge and poll until it reports a result (or
// we give up). Returns the same { httpOk, status, data } shape the localhost
// /run path produces, so callers can treat both transports identically.
export async function relayRun(
  body: Record<string, unknown>,
  { timeoutMs = 320_000 } = {}
): Promise<RelayRunResult> {
  if (!relayConfigured()) {
    return { httpOk: false, status: 401, data: { error: "No relay secret set." } };
  }
  // Enqueue.
  let id: string;
  try {
    const res = await fetch("/api/bridge/enqueue", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.id) {
      return { httpOk: false, status: res.status, data: { error: d.error || "relay enqueue failed" } };
    }
    id = d.id;
  } catch {
    return { httpOk: false, status: 0, data: { error: "Couldn't reach the cloud relay." } };
  }
  // Poll for the outcome. Interval matches the bridge's ~1.5s poll cadence; the
  // long timeout covers run_shell builds/tests on the laptop.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const res = await fetch(`/api/bridge/result?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      const d = await res.json().catch(() => ({}));
      if (d.found && d.status === "done" && d.result) {
        return { httpOk: !!d.result.ok, status: d.result.status ?? (d.result.ok ? 200 : 400), data: d.result.data };
      }
    } catch {
      /* transient — keep polling */
    }
  }
  return { httpOk: false, status: 504, data: { error: "Timed out waiting for your computer to run that." } };
}
