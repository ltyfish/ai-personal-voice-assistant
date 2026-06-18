import { NextResponse } from "next/server";
import { relayAuthorized, setPresence } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/bridge/heartbeat — the laptop bridge reports it's alive (and what it
// can do) every few seconds. Gated by the shared relay secret.
export async function POST(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  await setPresence({
    lastSeen: Date.now(),
    home: typeof body.home === "string" ? body.home : undefined,
    apps: Array.isArray(body.apps) ? body.apps.slice(0, 200) : undefined,
    shellEnabled: !!body.shellEnabled,
  });
  return NextResponse.json({ ok: true });
}
