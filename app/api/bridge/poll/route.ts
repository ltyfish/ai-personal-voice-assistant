import { NextResponse } from "next/server";
import { relayAuthorized, claimNext } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/bridge/poll — the laptop bridge pulls the next queued command (if
// any) and marks it running. Short-poll (the bridge calls this every ~1.5s),
// which is Vercel-friendly (no long-lived connection).
export async function GET(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const cmd = await claimNext();
  if (!cmd) return NextResponse.json({ ok: true, command: null });
  return NextResponse.json({ ok: true, command: { id: cmd.id, body: cmd.body } });
}
