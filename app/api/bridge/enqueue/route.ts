import { NextResponse } from "next/server";
import { relayAuthorized, enqueue } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/bridge/enqueue — the phone hands the cloud a confirmed local action
// (the same payload shape the bridge's /run accepts). Returns a command id the
// phone then polls via /api/bridge/result. The bridge re-validates the command
// locally, so enqueueing one doesn't bypass any of the bridge's safety gates.
export async function POST(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.action !== "string") {
    return NextResponse.json({ ok: false, error: "missing action" }, { status: 400 });
  }
  const id = await enqueue(body as Record<string, unknown>);
  return NextResponse.json({ ok: true, id });
}
