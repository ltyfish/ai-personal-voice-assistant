import { NextResponse } from "next/server";
import { relayAuthorized } from "@/lib/relay-store";
import { appendEvents, readEvents, type StoredPipelineEvent } from "@/lib/pipeline-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/pipeline/events — the laptop bridge pushes a batch of progress events
// for one project while a phase runs on the machine. Gated by the relay secret
// (the same key the bridge uses to heartbeat/poll).
export async function POST(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ ok: false, error: "missing project id" }, { status: 400 });
  const raw = Array.isArray(body.events) ? body.events : [];
  const events: Omit<StoredPipelineEvent, "i" | "ts">[] = raw
    .filter((e: unknown) => e && typeof e === "object")
    .map((e: any) => ({
      phase: String(e.phase || "info"),
      team: e.team ? String(e.team) : undefined,
      summary: String(e.summary || ""),
      detail: e.detail != null ? String(e.detail) : undefined,
      tool: e.tool ? String(e.tool) : undefined,
      status: e.status ? String(e.status) : undefined,
      round: typeof e.round === "number" ? e.round : undefined,
      model: e.model ? String(e.model) : undefined,
    }));
  const { cursor } = await appendEvents(id, events, { started: body.started === true });
  return NextResponse.json({ ok: true, cursor });
}

// GET /api/pipeline/events?id=<projectId>&since=<cursor> — the phone polls for
// new progress. Same relay-secret gate (the phone holds it too).
export async function GET(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = String(url.searchParams.get("id") || "");
  if (!id) return NextResponse.json({ error: "missing project id" }, { status: 400 });
  const since = Number(url.searchParams.get("since") || -1);
  const out = await readEvents(id, Number.isFinite(since) ? since : -1);
  return NextResponse.json(out);
}
